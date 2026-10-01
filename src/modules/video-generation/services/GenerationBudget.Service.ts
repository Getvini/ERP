import { EntityManager } from "typeorm";
import { AppDataSource } from "../../../data-source";
import { Tasks } from "../../task/entities/Task.entity";
import { VideoGenerations } from "../entities/VideoGeneration.entity";
import { MotionGenerations } from "../entities/MotionGeneration.entity";
import { OpportunityServiceJobs } from "../../opportunity-service/entities/OpportunityServiceJob.entity";

const RELEASED_STATUSES = ["failed", "provider_failed", "cancelled"];

export interface GenerationBudgetSnapshot {
    budgetMode: "LIMITED" | "UNLIMITED";
    limit: number | null;
    used: number;
    requested: number;
    remaining: number | null;
    allocationPercent: number | null;
}

type GenerationLimitContext = Pick<
    GenerationBudgetSnapshot,
    "budgetMode" | "limit" | "allocationPercent"
>;

/**
 * Serializes generation reservations per task so Video AI and Motion Control
 * share one fixed budget without concurrent requests overspending it.
 */
export class GenerationBudgetService {
    private async isUnlimitedOpportunityDemo(manager: EntityManager, task: Tasks): Promise<boolean> {
        if (!task.opportunityId || !task.opportunityServiceJobId) return false;

        const opportunityJob = await manager.getRepository(OpportunityServiceJobs).findOne({
            where: { id: task.opportunityServiceJobId },
        });
        return Boolean(opportunityJob?.isBriefVideo);
    }

    private async getConfiguredCost(manager: EntityManager, task: Tasks): Promise<number> {
        const taskWithPricingSource = await manager.getRepository(Tasks).findOne({
            where: { id: task.id },
            relations: ["job", "contractService", "contractService.opportunityService"],
        });
        if (!taskWithPricingSource) throw new Error("Không tìm thấy công việc");

        if (taskWithPricingSource.opportunityServiceJobId) {
            const opportunityJob = await manager.getRepository(OpportunityServiceJobs).findOne({
                where: { id: taskWithPricingSource.opportunityServiceJobId },
            });
            if (!opportunityJob) throw new Error("Không tìm thấy hạng mục công việc của cơ hội");
            return Number(opportunityJob.costAtSale || 0);
        }

        // Sau khi cơ hội được chuyển thành dự án, task mới không giữ
        // opportunityServiceJobId. ContractService vẫn trỏ về OpportunityService,
        // nên dùng cặp (opportunityService, job) để lấy đúng giá vốn BD đã nhập.
        const opportunityServiceId = taskWithPricingSource.contractService?.opportunityService?.id;
        const jobId = taskWithPricingSource.job?.id;
        if (opportunityServiceId && jobId) {
            const opportunityJob = await manager.getRepository(OpportunityServiceJobs).findOne({
                where: { opportunityServiceId, jobId },
            });
            if (opportunityJob) return Number(opportunityJob.costAtSale || 0);
        }

        return Number(taskWithPricingSource.cost || 0);
    }

    private async getLimitContext(
        manager: EntityManager,
        task: Tasks,
    ): Promise<GenerationLimitContext> {
        // Video AI demo is created while the sale is still an opportunity. Its
        // actual cost is only known after generation, so it must not require a
        // pre-configured cost limit. We still track every generation cost.
        if (await this.isUnlimitedOpportunityDemo(manager, task)) {
            return {
                budgetMode: "UNLIMITED",
                limit: null,
                allocationPercent: null,
            };
        }

        let budgetSourceTask = task;
        let allocationPercent: number;

        if (task.parentTaskId) {
            const parentTask = await manager.getRepository(Tasks).findOne({
                where: { id: task.parentTaskId },
            });
            if (!parentTask) throw new Error("Không tìm thấy task cha của công việc");
            budgetSourceTask = parentTask;
            allocationPercent = Number(task.allocationPercent || 0);
            if (!Number.isFinite(allocationPercent) || allocationPercent <= 0 || allocationPercent > 100) {
                throw new Error("% phân bổ của task con không hợp lệ");
            }
        } else {
            const subtasks = await manager.getRepository(Tasks).find({
                where: { parentTaskId: task.id },
            });
            const allocatedPercent = subtasks.reduce(
                (total, subtask) => total + Number(subtask.allocationPercent || 0),
                0,
            );
            if (!Number.isFinite(allocatedPercent) || allocatedPercent < 0 || allocatedPercent > 100) {
                throw new Error("Tổng % phân bổ task con không hợp lệ");
            }
            allocationPercent = 100 - allocatedPercent;
            if (allocationPercent <= 0) {
                throw new Error("Toàn bộ 100% công việc đã được phân bổ cho các task con");
            }
        }

        const configuredCost = await this.getConfiguredCost(manager, budgetSourceTask);
        const limit = Math.floor(configuredCost * allocationPercent / 100);
        if (!Number.isSafeInteger(limit) || limit <= 0) {
            throw new Error("Task chưa có giá vốn hợp lệ để tạo video AI");
        }
        return { budgetMode: "LIMITED", limit, allocationPercent };
    }

    async getSnapshot(taskId: string, userId: string): Promise<GenerationBudgetSnapshot> {
        const taskRepository = AppDataSource.getRepository(Tasks);
        const task = await taskRepository.findOne({
            where: { id: taskId },
            relations: ["assignee", "assignee.accounts"],
        });
        if (!task) throw new Error("Không tìm thấy công việc");
        if (!task.assignee?.accounts?.some((account) => account.id === userId)) {
            throw new Error("Bạn không phải người được phân công công việc này");
        }

        const { budgetMode, limit, allocationPercent } = await this.getLimitContext(AppDataSource.manager, task);

        const [videoResult, motionResult] = await Promise.all([
            AppDataSource.getRepository(VideoGenerations)
                .createQueryBuilder("generation")
                .select("COALESCE(SUM(generation.cost), 0)", "total")
                .where("generation.task_id = :taskId", { taskId })
                .andWhere("generation.status NOT IN (:...releasedStatuses)", {
                    releasedStatuses: RELEASED_STATUSES,
                })
                .getRawOne(),
            AppDataSource.getRepository(MotionGenerations)
                .createQueryBuilder("generation")
                .select("COALESCE(SUM(generation.cost), 0)", "total")
                .where("generation.task_id = :taskId", { taskId })
                .andWhere("generation.status NOT IN (:...releasedStatuses)", {
                    releasedStatuses: RELEASED_STATUSES,
                })
                .getRawOne(),
        ]);
        const used = Number(videoResult?.total || 0) + Number(motionResult?.total || 0);
        return {
            budgetMode,
            limit,
            used,
            requested: 0,
            remaining: budgetMode === "UNLIMITED" ? null : Math.max(0, limit! - used),
            allocationPercent,
        };
    }

    async reserve<T>(
        taskId: string,
        requestedCost: number,
        saveReservation: (manager: EntityManager, budget: GenerationBudgetSnapshot) => Promise<T>,
    ): Promise<{ reservation: T; budget: GenerationBudgetSnapshot }> {
        const normalizedCost = Number(requestedCost);
        if (!Number.isSafeInteger(normalizedCost) || normalizedCost < 0) {
            throw new Error("Chi phí tạo video phải là số nguyên không âm");
        }

        return AppDataSource.transaction(async (manager) => {
            const taskRepository = manager.getRepository(Tasks);
            const task = await taskRepository
                .createQueryBuilder("task")
                .setLock("pessimistic_write")
                .where("task.id = :taskId", { taskId })
                .getOne();

            if (!task) throw new Error("Không tìm thấy công việc");

            const { budgetMode, limit, allocationPercent } = await this.getLimitContext(manager, task);

            const [videoResult, motionResult] = await Promise.all([
                manager.getRepository(VideoGenerations)
                    .createQueryBuilder("generation")
                    .select("COALESCE(SUM(generation.cost), 0)", "total")
                    .where("generation.task_id = :taskId", { taskId })
                    .andWhere("generation.status NOT IN (:...releasedStatuses)", {
                        releasedStatuses: RELEASED_STATUSES,
                    })
                    .getRawOne(),
                manager.getRepository(MotionGenerations)
                    .createQueryBuilder("generation")
                    .select("COALESCE(SUM(generation.cost), 0)", "total")
                    .where("generation.task_id = :taskId", { taskId })
                    .andWhere("generation.status NOT IN (:...releasedStatuses)", {
                        releasedStatuses: RELEASED_STATUSES,
                    })
                    .getRawOne(),
            ]);

            const used = Number(videoResult?.total || 0) + Number(motionResult?.total || 0);
            const available = budgetMode === "UNLIMITED" ? null : Math.max(0, limit! - used);
            if (available !== null && normalizedCost > available) {
                throw new Error(
                    `Vượt hạn mức tạo video. Hạn mức: ${limit!.toLocaleString("vi-VN")} VNĐ, ` +
                    `đã dùng/đang giữ: ${used.toLocaleString("vi-VN")} VNĐ, ` +
                    `còn lại: ${available.toLocaleString("vi-VN")} VNĐ`,
                );
            }

            const budget: GenerationBudgetSnapshot = {
                budgetMode,
                limit,
                used: used + normalizedCost,
                requested: normalizedCost,
                remaining: budgetMode === "UNLIMITED" ? null : limit! - used - normalizedCost,
                allocationPercent,
            };
            const reservation = await saveReservation(manager, budget);
            return { reservation, budget };
        });
    }
}
