import { AppDataSource } from "../../../data-source";
import { VideoGenerations } from "../entities/VideoGeneration.entity";
import { AiModels } from "../../ai-model/entities/AiModel.entity";
import { Projects } from "../../project/entities/Project.entity";
import { AssetService } from "../../asset/services/Asset.Service";
import { CloudinaryVideoAiService } from "../../cloudinary/services/CloudinaryVideoAi.Service";
import { KlingService } from "../../kling/services/Kling.Service";
import { ByteplusService } from "../../byteplus/services/Byteplus.Service";
import { CreateVideoDto } from "../dto/CreateVideo.dto";
import { Tasks } from "../../task/entities/Task.entity";
import { Opportunities } from "../../opportunity/entities/Opportunity.entity";
import { GenerationBudgetService } from "./GenerationBudget.Service";

export class VideoGenerationService {
    private videoGenRepository = AppDataSource.getRepository(VideoGenerations);
    private modelRepository = AppDataSource.getRepository(AiModels);
    private projectRepository = AppDataSource.getRepository(Projects);
    private taskRepository = AppDataSource.getRepository(Tasks);
    private opportunityRepository = AppDataSource.getRepository(Opportunities);
    private generationBudgetService = new GenerationBudgetService();

    private assetService = new AssetService();
    private cloudinaryVideoAiService = new CloudinaryVideoAiService();
    private klingService = new KlingService();
    private byteplusService = new ByteplusService();

    async createVideo(
        userId: string,
        dto: CreateVideoDto,
        startImageFile?: Express.Multer.File,
        endImageFile?: Express.Multer.File,
    ) {
        if (!dto.projectId && !dto.opportunityId) throw new Error("Vui lòng chọn dự án hoặc cơ hội");
        if (dto.projectId && dto.opportunityId) throw new Error("Chỉ được chọn một dự án hoặc một cơ hội");
        if (dto.projectId) {
            const project = await this.projectRepository.findOne({ where: { id: dto.projectId } });
            if (!project) throw new Error("Không tìm thấy project");
        }
        if (dto.opportunityId) {
            const opportunity = await this.opportunityRepository.findOne({ where: { id: dto.opportunityId } });
            if (!opportunity) throw new Error("Không tìm thấy cơ hội");
        }

        if (!dto.taskId) throw new Error("Vui lòng chọn công việc (task) của dự án");
        const task = await this.taskRepository.findOne({
            where: { id: dto.taskId },
            relations: ["project", "opportunity", "assignee", "assignee.accounts"],
        });
        if (!task) throw new Error("Không tìm thấy công việc");
        if (dto.projectId && task.project?.id !== dto.projectId) throw new Error("Công việc không thuộc dự án đã chọn");
        if (dto.opportunityId && task.opportunity?.id !== dto.opportunityId) throw new Error("Công việc không thuộc cơ hội đã chọn");
        if (!task.assignee?.accounts?.some((account) => account.id === userId)) {
            throw new Error("Bạn không phải người được phân công công việc này");
        }

        // 2. Validate model
        const model = await this.modelRepository.findOne({
            where: { id: dto.modelId },
            relations: ["provider"],
        });
        if (!model) throw new Error("Model không tồn tại");
        if (model.modelType !== "video_generation") {
            throw new Error("Model không phải video generation");
        }

        const isByteplus = model.provider?.code === "byteplus";
        const isKlingV26 = model.provider?.code === "kling" && model.code === "kling-v2-6";

        if (isKlingV26) {
            const duration = Number(dto.duration || 5);
            const mode = dto.mode || "pro";
            const hasEndFrame = Boolean(dto.endImageAssetId || endImageFile);

            if (dto.multiShot) {
                throw new Error("Kling Video 2.6 không hỗ trợ Multi-Shot");
            }
            if (![5, 10].includes(duration)) {
                throw new Error("Kling Video 2.6 chỉ hỗ trợ thời lượng 5 hoặc 10 giây");
            }
            if (mode !== "std" && mode !== "pro") {
                throw new Error("Kling Video 2.6 chỉ hỗ trợ chế độ 720P hoặc 1080P");
            }
            if (mode === "std" && dto.sound === "on") {
                throw new Error("Kling Video 2.6 ở chế độ 720P chỉ hỗ trợ video không âm thanh");
            }
            if (hasEndFrame && (mode !== "pro" || dto.sound === "on")) {
                throw new Error("Kling Video 2.6 khi dùng End Frame chỉ hỗ trợ 1080P và không âm thanh");
            }
        }

        // 3. Validate multi-shot (chỉ Kling hỗ trợ; BytePlus không hỗ trợ multi-shot)
        if (!isByteplus && dto.multiShot) {
            if (!dto.shotType) throw new Error("shotType là bắt buộc khi multiShot=true");
            if (dto.shotType === "customize") {
                if (!dto.multiPrompt || dto.multiPrompt.length === 0) {
                    throw new Error("multiPrompt là bắt buộc khi shotType=customize");
                }
                const totalShotDuration = dto.multiPrompt.reduce((sum, s) => sum + Number(s.duration), 0);
                const videoDuration = Number(dto.duration || 5);
                if (totalShotDuration !== videoDuration) {
                    throw new Error(
                        `Tổng duration của shots (${totalShotDuration}s) phải bằng duration video (${videoDuration}s)`,
                    );
                }
            } else if (dto.shotType === "intelligence") {
                if (!dto.prompt?.trim()) throw new Error("prompt là bắt buộc khi shotType=intelligence");
            }
        } else {
            if (!dto.prompt?.trim()) throw new Error("prompt là bắt buộc");
        }

        const contextFolder = dto.projectId ? `projects/${dto.projectId}` : `opportunities/${dto.opportunityId}`;
        const baseFolder = `ai-generation/users/${userId}/${contextFolder}/videos`;

        // 4. Resolve start image (reuse asset có sẵn hoặc upload mới)
        const beginAsset = await this.assetService.resolveImageAsset(
            userId, dto.startImageAssetId, startImageFile, baseFolder, "begin", "image_begin",
        );
        if (!beginAsset) throw new Error("Cần cung cấp startImage hoặc startImageAssetId");
        if (dto.projectId) await this.assetService.attachProjectIfMissing(beginAsset.id, dto.projectId);

        // 5. Resolve end image nếu có
        let endAsset = null;
        if (dto.endImageAssetId || endImageFile) {
            endAsset = await this.assetService.resolveImageAsset(
                userId, dto.endImageAssetId, endImageFile, baseFolder, "end", "image_end",
            );
            if (endAsset && dto.projectId) await this.assetService.attachProjectIfMissing(endAsset.id, dto.projectId);
        }

        // 6. Giữ ngân sách trước khi gọi provider. Bản ghi pending là khoản giữ
        // ngân sách để các request đồng thời không thể cùng vượt hạn mức.
        const storedPrompt = this.buildStoredPrompt(dto, isByteplus);
        const { reservation: saved, budget } = await this.generationBudgetService.reserve(
            dto.taskId,
            dto.cost ?? 0,
            async (manager) => manager.getRepository(VideoGenerations).save(
                manager.getRepository(VideoGenerations).create({
                    projectId: dto.projectId,
                    opportunityId: dto.opportunityId,
                    taskId: dto.taskId,
                    modelId: dto.modelId,
                    userId,
                    imageBeginAssetId: beginAsset.id,
                    imageEndAssetId: endAsset?.id,
                    motionPrompt: storedPrompt,
                    negativePrompt: dto.negativePrompt,
                    status: "pending",
                    durationSeconds: Number(dto.duration || 5),
                    generationMode: isByteplus ? (dto.resolution || "720p") : (dto.mode || "std"),
                    generationRatio: isByteplus ? dto.ratio : undefined,
                    generationSound: dto.sound === "on",
                    cost: dto.cost,
                    params: {
                        resolution: dto.resolution,
                        ratio: dto.ratio,
                        mode: dto.mode,
                        multiShot: dto.multiShot ?? false,
                        shotType: dto.shotType,
                    },
                    requestPayload: {
                        modelName: model.code,
                        prompt: dto.prompt,
                        duration: dto.duration,
                        mode: dto.mode,
                        ratio: dto.ratio,
                        sound: dto.sound,
                        multiShot: dto.multiShot ?? false,
                        shotType: dto.shotType,
                        multiPrompt: dto.multiPrompt,
                    },
                    responsePayload: {},
                    startedAt: new Date(),
                }),
            ),
        );

        // 7. Rẽ nhánh theo provider: Kling hay BytePlus
        let externalTaskId: string;
        let responsePayloadRaw: any;
        try {
            if (isByteplus) {
                const bytePlusCreate = await this.byteplusService.createVideoTask({
                    modelCode: model.code,
                    prompt: dto.prompt,
                    imageUrl: beginAsset.storedUrl,
                    imageTailUrl: endAsset?.storedUrl,
                    resolution: dto.resolution,
                    ratio: dto.ratio,
                    duration: Number(dto.duration || 5),
                    generateAudio: dto.sound === "on",
                });
                externalTaskId = bytePlusCreate.id;
                responsePayloadRaw = bytePlusCreate;
            } else {
                const klingCreate = await this.klingService.createImageToVideo({
                    modelName: model.code,
                    imageUrl: beginAsset.storedUrl,
                    imageTailUrl: endAsset?.storedUrl,
                    prompt: dto.prompt,
                    sound: dto.sound || "off",
                    negativePrompt: dto.negativePrompt,
                    duration: dto.duration || "5",
                    mode: (dto.mode as "std" | "pro" | "4k") || "pro",
                    multiShot: dto.multiShot,
                    shotType: dto.shotType,
                    multiPrompt: dto.multiPrompt,
                });

                if (klingCreate.code !== 0) throw new Error(`Kling error: ${klingCreate.message}`);
                externalTaskId = klingCreate.data.task_id;
                responsePayloadRaw = klingCreate;
            }

            await this.videoGenRepository.update(saved.id, {
                status: "queued",
                externalTaskId,
                responsePayload: responsePayloadRaw,
            });
        } catch (error: any) {
            await this.videoGenRepository.update(saved.id, {
                status: "failed",
                errorMessage: error.message,
                completedAt: new Date(),
            });
            throw error;
        }

        // 8. Polling ngầm — chọn theo provider
        if (isByteplus) {
            this.pollAndSaveResultByteplus(saved.id, externalTaskId, userId).catch((err) =>
                console.error(`[VideoGen] BytePlus polling error: ${err.message}`),
            );
        } else {
            this.pollAndSaveResult(saved.id, externalTaskId, userId).catch((err) =>
                console.error(`[VideoGen] Kling polling error: ${err.message}`),
            );
        }

        return {
            message: "Đang tạo video, vui lòng chờ...",
            videoGenerationId: saved.id,
            projectId: dto.projectId,
            opportunityId: dto.opportunityId,
            taskId: dto.taskId,
            externalTaskId: externalTaskId,
            status: "queued",
            beginImageUrl: beginAsset.storedUrl,
            endImageUrl: endAsset?.storedUrl ?? null,
            promptSent: storedPrompt,
            modelName: model.name,
            generationMode: isByteplus ? (dto.resolution || "720p") : (dto.mode || "pro"),
            multiShot: !isByteplus && (dto.multiShot ?? false),
            shotType: dto.shotType,
            cost: dto.cost ?? 0,
            budgetMode: budget.budgetMode,
            budgetLimit: budget.limit,
            budgetUsed: budget.used,
            budgetRemaining: budget.remaining,
        };
    }

    private buildStoredPrompt(dto: CreateVideoDto, isByteplus = false): string {
        if (!isByteplus && dto.multiShot && dto.shotType === "customize" && dto.multiPrompt?.length) {
            return dto.multiPrompt.map((s) => `[Shot ${s.index}] ${s.prompt} (${s.duration}s)`).join(" | ");
        }
        return dto.prompt || "";
    }

    private async pollAndSaveResult(videoGenId: number, taskId: string, userId: string) {
        try {
            await this.videoGenRepository.update(videoGenId, { status: "processing" });
            const taskResult = await this.klingService.pollUntilDone(taskId, 30000, 40);
            const videoData = taskResult.task_result?.videos?.[0];
            if (!videoData) throw new Error("Kling trả về succeed nhưng không có video URL");

            const videoGen = await this.videoGenRepository.findOne({ where: { id: videoGenId } });
            const cloudinaryVideoUrl = await this.cloudinaryVideoAiService.uploadVideoFromUrl(
                videoData.url,
                `ai-generation/users/${userId}/${videoGen?.projectId ? `projects/${videoGen.projectId}` : `opportunities/${videoGen?.opportunityId}`}/videos/output`,
                `video_${videoGenId}_${Date.now()}`,
            );

            const videoAsset = await this.assetService.createGeneratedAsset({
                userId,
                projectId: videoGen?.projectId,
                assetType: "video",
                assetRole: "scene_video",
                sourceType: "generated",
                originalUrl: videoData.url,
                storedUrl: cloudinaryVideoUrl,
                storageProvider: "cloudinary",
                durationSeconds: videoData.duration ? Math.round(parseFloat(videoData.duration)) : undefined,
                metadata: { kling_video_id: videoData.id, duration: videoData.duration },
            });

            await this.videoGenRepository.update(videoGenId, {
                status: "succeeded",
                outputAssetId: videoAsset.id,
                completedAt: new Date(),
                resultPayload: taskResult as any,
            });
        } catch (err: any) {
            console.error(`[VideoGen ${videoGenId}] FAILED: ${err.message}`);
            await this.videoGenRepository.update(videoGenId, {
                status: "failed",
                errorMessage: err.message,
                completedAt: new Date(),
            });
        }
    }

    private async pollAndSaveResultByteplus(videoGenId: number, taskId: string, userId: string) {
        try {
            await this.videoGenRepository.update(videoGenId, { status: "processing" });
            const taskResult = await this.byteplusService.pollUntilDone(taskId, 30000, 40);
            const videoUrl = taskResult.content?.video_url;
            if (!videoUrl) throw new Error("BytePlus trả về succeeded nhưng không có video URL");

            const videoGen = await this.videoGenRepository.findOne({ where: { id: videoGenId } });
            const cloudinaryVideoUrl = await this.cloudinaryVideoAiService.uploadVideoFromUrl(
                videoUrl,
                `ai-generation/users/${userId}/${videoGen?.projectId ? `projects/${videoGen.projectId}` : `opportunities/${videoGen?.opportunityId}`}/videos/output`,
                `video_${videoGenId}_${Date.now()}`,
            );

            const videoAsset = await this.assetService.createGeneratedAsset({
                userId,
                projectId: videoGen?.projectId,
                assetType: "video",
                assetRole: "scene_video",
                sourceType: "generated",
                originalUrl: videoUrl,
                storedUrl: cloudinaryVideoUrl,
                storageProvider: "cloudinary",
                durationSeconds: taskResult.duration ? Math.round(Number(taskResult.duration)) : undefined,
                metadata: { byteplus_task_id: taskResult.id, duration: taskResult.duration },
            });

            await this.videoGenRepository.update(videoGenId, {
                status: "succeeded",
                outputAssetId: videoAsset.id,
                completedAt: new Date(),
                resultPayload: taskResult as any,
            });
        } catch (err: any) {
            console.error(`[VideoGen ${videoGenId}] BytePlus FAILED: ${err.message}`);
            await this.videoGenRepository.update(videoGenId, {
                status: "failed",
                errorMessage: err.message,
                completedAt: new Date(),
            });
        }
    }

    async getStatus(id: number) {
        const videoGen = await this.videoGenRepository.findOne({
            where: { id },
            relations: ["outputAsset", "imageBeginAsset", "imageEndAsset"],
        });
        if (!videoGen) throw new Error("Không tìm thấy video generation");

        return {
            id: videoGen.id,
            status: videoGen.status,
            taskId: videoGen.externalTaskId,
            promptSent: videoGen.motionPrompt,
            beginImageUrl: videoGen.imageBeginAsset?.storedUrl ?? null,
            endImageUrl: videoGen.imageEndAsset?.storedUrl ?? null,
            videoUrl: videoGen.outputAsset?.storedUrl ?? null,
            duration: videoGen.durationSeconds,
            errorMessage: videoGen.errorMessage ?? null,
            createdAt: videoGen.createdAt,
            completedAt: videoGen.completedAt ?? null,
        };
    }

    async getHistory(userId: string, projectId?: string) {
        const qb = this.videoGenRepository
            .createQueryBuilder("vg")
            .leftJoinAndSelect("vg.outputAsset", "outputAsset")
            .leftJoinAndSelect("vg.imageBeginAsset", "imageBeginAsset")
            .leftJoinAndSelect("vg.imageEndAsset", "imageEndAsset")
            .leftJoinAndSelect("vg.model", "model")
            .leftJoinAndSelect("model.provider", "provider")
            .where("vg.user_id = :userId", { userId });

        if (projectId) {
            qb.andWhere("vg.project_id = :projectId", { projectId });
        }

        const list = await qb.orderBy("vg.created_at", "DESC").limit(50).getMany();

        return list.map((vg) => ({
            id: vg.id,
            status: vg.status,
            promptSent: vg.motionPrompt,
            videoUrl: vg.outputAsset?.storedUrl ?? null,
            thumbnailUrl: vg.imageBeginAsset?.storedUrl ?? null,
            beginImageUrl: vg.imageBeginAsset?.storedUrl ?? null,
            endImageUrl: vg.imageEndAsset?.storedUrl ?? null,
            modelName: vg.model?.name ?? "Unknown",
            providerName: vg.model?.provider?.name ?? "Unknown",
            durationSeconds: vg.durationSeconds,
            generationMode: vg.generationMode,
            cost: vg.cost ?? 0,
            createdAt: vg.createdAt,
        }));
    }
}
