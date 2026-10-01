import { AppDataSource } from "../../../data-source";
import { AssetService } from "../../asset/services/Asset.Service";
import { ByteplusService, BytePlusTaskResult } from "../../byteplus/services/Byteplus.Service";
import { CloudinaryVideoAiService } from "../../cloudinary/services/CloudinaryVideoAi.Service";
import { KlingService, KlingTaskResult } from "../../kling/services/Kling.Service";
import { VideoGenerations } from "../entities/VideoGeneration.entity";

const RECONCILABLE_STATUSES = [
    "queued",
    "processing",
    "delayed",
    "provider_succeeded",
    "uploading",
    "upload_failed",
];

const TERMINAL_STATUSES = ["succeeded", "provider_failed", "failed", "cancelled"];
const DELAYED_AFTER_MS = 30 * 60 * 1000;

export class VideoGenerationReconciliationService {
    private static activeGenerationIds = new Set<number>();
    private repository = AppDataSource.getRepository(VideoGenerations);
    private assetService = new AssetService();
    private cloudinaryVideoAiService = new CloudinaryVideoAiService();
    private klingService = new KlingService();
    private byteplusService = new ByteplusService();

    async reconcilePending(limit = 25): Promise<number> {
        const candidates = await this.repository
            .createQueryBuilder("generation")
            .leftJoinAndSelect("generation.model", "model")
            .leftJoinAndSelect("model.provider", "provider")
            .where("generation.status IN (:...statuses)", { statuses: RECONCILABLE_STATUSES })
            .andWhere("generation.external_task_id IS NOT NULL")
            .andWhere("(generation.next_poll_at IS NULL OR generation.next_poll_at <= :now)", { now: new Date() })
            .andWhere("(generation.reconcile_lease_until IS NULL OR generation.reconcile_lease_until <= :now)", { now: new Date() })
            .orderBy("generation.next_poll_at", "ASC", "NULLS FIRST")
            .addOrderBy("generation.created_at", "ASC")
            .take(limit)
            .getMany();

        let processed = 0;
        for (const candidate of candidates) {
            if (await this.reconcileOne(candidate.id)) processed += 1;
        }
        return processed;
    }

    async handleKlingCallback(payload: KlingTaskResult & { task_info?: { external_task_id?: string } }): Promise<boolean> {
        const externalReferenceId = payload.task_info?.external_task_id;
        const qb = this.repository
            .createQueryBuilder("generation")
            .leftJoinAndSelect("generation.model", "model")
            .leftJoinAndSelect("model.provider", "provider")
            .where("generation.external_task_id = :taskId", { taskId: payload.task_id });

        if (externalReferenceId) {
            qb.orWhere("generation.external_reference_id = :externalReferenceId", { externalReferenceId });
        }

        const generation = await qb.getOne();
        if (!generation) return false;
        if (TERMINAL_STATUSES.includes(generation.status)) return true;
        if (VideoGenerationReconciliationService.activeGenerationIds.has(generation.id)) return true;
        if (!(await this.claim(generation.id))) return true;

        VideoGenerationReconciliationService.activeGenerationIds.add(generation.id);
        try {
            // Callback chỉ ghi nhận kết quả bền vững rồi trả 200 nhanh. Việc tải
            // video sang Cloudinary được cron tiếp tục từ provider_succeeded.
            await this.processKlingTask(generation, payload, true);
            return true;
        } finally {
            VideoGenerationReconciliationService.activeGenerationIds.delete(generation.id);
            await this.release(generation.id);
        }
    }

    private async reconcileOne(id: number): Promise<boolean> {
        if (VideoGenerationReconciliationService.activeGenerationIds.has(id)) return false;
        if (!(await this.claim(id))) return false;
        VideoGenerationReconciliationService.activeGenerationIds.add(id);

        try {
            const generation = await this.repository.findOne({
                where: { id },
                relations: ["model", "model.provider"],
            });
            if (!generation || TERMINAL_STATUSES.includes(generation.status)) return false;

            if (["provider_succeeded", "uploading", "upload_failed"].includes(generation.status)) {
                await this.retryStoredUpload(generation);
                return true;
            }

            if (!generation.externalTaskId) return false;

            if (generation.model?.provider?.code === "byteplus") {
                const task = await this.byteplusService.getTaskStatus(generation.externalTaskId);
                await this.processByteplusTask(generation, task);
            } else {
                const response = await this.klingService.getTaskStatus(generation.externalTaskId);
                if (response.code !== 0 || !response.data) {
                    throw new Error(`Kling query error (${response.code}): ${response.message}`);
                }
                await this.processKlingTask(generation, response.data);
            }
            return true;
        } catch (error: any) {
            const generation = await this.repository.findOne({ where: { id } });
            if (generation && !TERMINAL_STATUSES.includes(generation.status)) {
                if (["provider_succeeded", "uploading", "upload_failed"].includes(generation.status)) {
                    await this.repository.update(id, {
                        status: "upload_failed",
                        errorMessage: error.message || "Không thể lưu lại video",
                        lastPolledAt: new Date(),
                        nextPollAt: new Date(Date.now() + 5 * 60 * 1000),
                    });
                } else {
                    await this.scheduleNextPoll(generation, error.message || "Không thể kiểm tra trạng thái provider");
                }
            }
            console.error(`[VideoReconcile ${id}] ${error.message}`);
            return false;
        } finally {
            VideoGenerationReconciliationService.activeGenerationIds.delete(id);
            await this.release(id);
        }
    }

    private async claim(id: number): Promise<boolean> {
        const now = new Date();
        const leaseUntil = new Date(now.getTime() + 10 * 60 * 1000);
        const result = await this.repository
            .createQueryBuilder()
            .update(VideoGenerations)
            .set({ reconcileLeaseUntil: leaseUntil })
            .where("id = :id", { id })
            .andWhere("(reconcile_lease_until IS NULL OR reconcile_lease_until <= :now)", { now })
            .returning(["id"])
            .execute();
        return Array.isArray(result.raw) && result.raw.length > 0;
    }

    private async release(id: number): Promise<void> {
        await this.repository.update(id, { reconcileLeaseUntil: null as any });
    }

    private async processKlingTask(
        generation: VideoGenerations,
        task: KlingTaskResult,
        deferUpload = false,
    ): Promise<void> {
        if (task.task_status === "failed") {
            await this.markProviderFailed(generation.id, task.task_status_msg || "Kling tạo video thất bại", task);
            return;
        }

        if (task.task_status === "succeed") {
            const video = task.task_result?.videos?.[0];
            if (!video?.url) {
                await this.markProviderFailed(generation.id, "Kling trả về succeed nhưng không có video URL", task);
                return;
            }
            if (deferUpload) {
                await this.repository.update(generation.id, {
                    status: "provider_succeeded",
                    resultPayload: task as any,
                    responsePayload: task as any,
                    errorMessage: null as any,
                    nextPollAt: new Date(),
                    lastPolledAt: new Date(),
                });
                return;
            }
            await this.finalizeProviderSuccess(generation, task, video.url, video.id, video.duration);
            return;
        }

        await this.scheduleNextPoll(generation, null, task);
    }

    private async processByteplusTask(generation: VideoGenerations, task: BytePlusTaskResult): Promise<void> {
        if (["failed", "expired", "cancelled"].includes(task.status)) {
            await this.markProviderFailed(
                generation.id,
                task.error?.message || `BytePlus task ${task.status}`,
                task,
            );
            return;
        }

        if (task.status === "succeeded") {
            const videoUrl = task.content?.video_url;
            if (!videoUrl) {
                await this.markProviderFailed(generation.id, "BytePlus trả về succeeded nhưng không có video URL", task);
                return;
            }
            await this.finalizeProviderSuccess(generation, task, videoUrl, task.id, task.duration);
            return;
        }

        await this.scheduleNextPoll(generation, null, task);
    }

    private async finalizeProviderSuccess(
        generation: VideoGenerations,
        providerResult: KlingTaskResult | BytePlusTaskResult,
        videoUrl: string,
        providerVideoId?: string,
        duration?: string | number,
    ): Promise<void> {
        const current = await this.repository.findOne({ where: { id: generation.id } });
        if (!current || current.outputAssetId || current.status === "succeeded") return;

        await this.repository.update(generation.id, {
            status: "provider_succeeded",
            resultPayload: providerResult as any,
            responsePayload: providerResult as any,
            errorMessage: null as any,
            nextPollAt: null as any,
            lastPolledAt: new Date(),
        });

        try {
            await this.repository.update(generation.id, { status: "uploading" });
            const cloudinaryVideoUrl = await this.cloudinaryVideoAiService.uploadVideoFromUrl(
                videoUrl,
                `ai-generation/users/${generation.userId}/${generation.projectId ? `projects/${generation.projectId}` : `opportunities/${generation.opportunityId}`}/videos/output`,
                `video_${generation.id}_${Date.now()}`,
            );

            const videoAsset = await this.assetService.createGeneratedAsset({
                userId: generation.userId,
                projectId: generation.projectId,
                assetType: "video",
                assetRole: "scene_video",
                sourceType: "generated",
                originalUrl: videoUrl,
                storedUrl: cloudinaryVideoUrl,
                storageProvider: "cloudinary",
                durationSeconds: duration ? Math.round(Number(duration)) : undefined,
                metadata: { provider_video_id: providerVideoId, duration },
            });

            await this.repository.update(generation.id, {
                status: "succeeded",
                outputAssetId: videoAsset.id,
                errorMessage: null as any,
                nextPollAt: null as any,
                completedAt: new Date(),
            });
        } catch (error: any) {
            await this.repository.update(generation.id, {
                status: "upload_failed",
                errorMessage: error.message || "Không thể lưu video lên Cloudinary",
                nextPollAt: new Date(Date.now() + 2 * 60 * 1000),
            });
        }
    }

    private async retryStoredUpload(generation: VideoGenerations): Promise<void> {
        const result = generation.resultPayload as any;
        if (generation.model?.provider?.code === "byteplus") {
            const videoUrl = result?.content?.video_url;
            if (!videoUrl) throw new Error("Không còn URL BytePlus để thử lưu lại video");
            await this.finalizeProviderSuccess(generation, result, videoUrl, result.id, result.duration);
            return;
        }

        const video = result?.task_result?.videos?.[0];
        if (!video?.url) throw new Error("Không còn URL Kling để thử lưu lại video");
        await this.finalizeProviderSuccess(generation, result, video.url, video.id, video.duration);
    }

    private async scheduleNextPoll(
        generation: VideoGenerations,
        errorMessage: string | null,
        responsePayload?: object,
    ): Promise<void> {
        const attempts = Number(generation.pollAttempts || 0) + 1;
        const delayMinutes = attempts <= 1 ? 1 : attempts <= 3 ? 2 : 5;
        const startedAt = generation.startedAt || generation.createdAt || new Date();
        const isDelayed = Date.now() - startedAt.getTime() >= DELAYED_AFTER_MS;

        await this.repository.update(generation.id, {
            status: isDelayed ? "delayed" : "processing",
            pollAttempts: attempts,
            lastPolledAt: new Date(),
            nextPollAt: new Date(Date.now() + delayMinutes * 60 * 1000),
            errorMessage: (errorMessage || null) as any,
            ...(responsePayload ? { responsePayload: responsePayload as any } : {}),
        });
    }

    private async markProviderFailed(id: number, message: string, providerResult: object): Promise<void> {
        await this.repository.update(id, {
            status: "provider_failed",
            errorMessage: message,
            responsePayload: providerResult as any,
            resultPayload: providerResult as any,
            nextPollAt: null as any,
            lastPolledAt: new Date(),
            completedAt: new Date(),
        });
    }
}
