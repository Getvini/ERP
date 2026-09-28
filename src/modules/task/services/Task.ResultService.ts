import { AppDataSource } from "../../../data-source";
import { Tasks } from "../entities/Task.entity";
import { TaskStatus, PerformerType, PricingStatus, ViolationType } from "../../../shared/entities/Enums";
import { ILike, Like, Between, IsNull, In } from "typeorm";
import { Projects, ProjectStatus } from "../../project/entities/Project.entity";
import { Jobs } from "../../job/entities/Job.entity";
import { Users } from "../../user/entities/User.entity";
import { Vendors } from "../../vendor/entities/Vendor.entity";
import { VendorJobs } from "../../vendor/entities/VendorJob.entity";
import { NotificationService } from "../../notification/services/Notification.Service";
import { TaskReviewService } from "./TaskReview.Service";
import { StringHelper } from "../../../shared/helpers/String.helper";
import { Contracts } from "../../contract/entities/Contract.entity";
import { TaskReviews } from "../entities/TaskReview.entity";
import { SecurityService } from "../../../shared/services/Security.Service";
import { ContractServices, ContractServiceStatus } from "../../contract/entities/ContractService.entity";
import { Violations } from "../entities/Violation.entity";
import { taskEmitter, TASK_EVENTS } from "../events/TaskEmitter";
import { UserRole } from "../../account/entities/Account.entity";
import { TaskResultCheckService } from "./TaskResultCheck.Service";
import { assertSubtasksCompleted } from "../helpers/SubtaskCompletion.helper";
import { assertSubtaskPlanApproved } from "../helpers/SubtaskPlanApproval.helper";
import { assertSubtaskDeadlineNotExceedParent } from "../helpers/SubtaskDeadline.helper";
import { TaskResultChecks } from "../entities/TaskResultCheck.entity";
import { buildCheckSummary } from "../../../shared/helpers/CheckSummary.helper";
import { VinicoinService } from "../../../shared/services/Vinicoin.Service";
import { RedisService } from "../../../shared/services/Redis.Service";
import {
    canDecideTaskOutcome,
    getTaskSubmissionReviewRecipientIds
} from "../helpers/TaskOutcomeAuthorization.helper";

import { TaskBaseService } from "./Task.BaseService";

type SubmitResultData = {
    result: any;
    sheetNames?: string[];
    whitelist?: string[];
    scenarioIds?: string[];
    scenarioLabels?: string[];
    fileBuffer?: Buffer;
    checkFileUrl?: string;
    checkFileName?: string;
    draft?: boolean;
};

function buildSubmissionDetails(sheetNames?: string[], scenarioLabels?: string[]): string {
    const parts: string[] = [];
    if (sheetNames && sheetNames.length > 0) parts.push(`${sheetNames.length} sheet`);
    if (scenarioLabels && scenarioLabels.length > 0) parts.push(`${scenarioLabels.length} kịch bản`);
    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

export class TaskResultService extends TaskBaseService {
    private resultCheckService = new TaskResultCheckService();
    private vinicoinService = new VinicoinService();

    async submitResult(id: string, data: SubmitResultData, currentUser?: { id: string, userId?: string; role?: string }) {
        const task = await this.getOne(id);
        this.assertTaskProjectNotOnHold(task);
        const submittableStatuses = [
            TaskStatus.DOING,
            TaskStatus.REJECTED,
            TaskStatus.REWORKING,
            TaskStatus.OVERDUE
        ];
        if (!submittableStatuses.includes(task.status)) {
            throw this.httpError("Công việc phải được bắt đầu trước khi nộp kết quả", 409);
        }
        await assertSubtaskPlanApproved(this.taskRepository, task, "nộp kết quả");
        await assertSubtasksCompleted(this.taskRepository, task, "nộp kết quả");
        const currentId = await this.resolveActorUserId(currentUser);
        if (!currentId) throw this.httpError("Tài khoản chưa được liên kết nhân sự để nộp kết quả", 401);
        const resultType = data.result?.type;
        if (!data.result || ((resultType === "FILE" || resultType === "LINK") && !data.result.url)) {
            throw this.httpError("Kết quả công việc không hợp lệ", 400);
        }

        task.result = {
            ...data.result,
            sheetNames: data.sheetNames && data.sheetNames.length > 0 ? data.sheetNames : undefined,
            scenarioLabels: data.scenarioLabels && data.scenarioLabels.length > 0 ? data.scenarioLabels : undefined,
            checkFileUrl: data.checkFileUrl,
            checkFileName: data.checkFileName
        };
        task.lastSubmittedById = currentId;

        const savedTask = await this.taskRepository.save(task);

        if (data.draft) {
            taskEmitter.emit(TASK_EVENTS.UPDATED, savedTask);
            return savedTask;
        }

        return this.submitSavedResultForReview(id, currentUser, {
            fileBuffer: data.fileBuffer,
            sheetNames: data.sheetNames,
            whitelist: data.whitelist,
            scenarioIds: data.scenarioIds,
            scenarioLabels: data.scenarioLabels,
            checkFileUrl: data.checkFileUrl,
            checkFileName: data.checkFileName
        });
    }

    async submitSavedResultForReview(
        id: string,
        currentUser?: { id: string, userId?: string; role?: string },
        checkOptions: Omit<SubmitResultData, "result" | "draft"> = {}
    ) {
        const task = await this.getOne(id);
        this.assertTaskProjectNotOnHold(task);
        const submittableStatuses = [
            TaskStatus.DOING,
            TaskStatus.REJECTED,
            TaskStatus.REWORKING,
            TaskStatus.OVERDUE
        ];
        if (!submittableStatuses.includes(task.status)) {
            throw this.httpError("Công việc phải được bắt đầu trước khi gửi duyệt kết quả", 409);
        }
        await assertSubtaskPlanApproved(this.taskRepository, task, "gửi duyệt kết quả");
        await assertSubtasksCompleted(this.taskRepository, task, "gửi duyệt kết quả");
        const currentId = await this.resolveActorUserId(currentUser);
        if (!currentId) throw this.httpError("Tài khoản chưa được liên kết nhân sự để gửi duyệt kết quả", 401);

        const resultType = task.result?.type;
        if (!task.result || ((resultType === "FILE" || resultType === "LINK") && !task.result.url)) {
            throw this.httpError("Vui lòng upload hoặc nhập kết quả trước khi gửi duyệt", 400);
        }

        // Chỉ tự động duyệt khi chính người nộp cũng có quyền quyết định kết quả.
        // Hàm dùng chung bên dưới luôn loại người thực hiện/helper khỏi quyền này.
        const shouldAutoApprove = canDecideTaskOutcome(task, currentId);

        task.actualEndDate = new Date();
        task.lastSubmittedById = currentId;
        task.status = TaskStatus.AWAITING_REVIEW;

        const savedTask = await this.taskRepository.save(task);

        // Check for late submission
        if (task.plannedEndDate && new Date() > task.plannedEndDate) {
            await this.recordViolation({
                taskId: task.id,
                userId: currentId,
                type: ViolationType.LATE_SUBMISSION,
                description: `Nộp task trễ deadline. Deadline: ${task.plannedEndDate.toLocaleString()}`
            });
        }

        if (shouldAutoApprove) {
            // Lead quản lý task của người khác → auto duyệt
            await this.reviewService.initializeReviews(task.id, true);
            await this.reviewService.checkAndFinalize(task.id, undefined, undefined, currentUser);
        } else {
            // Lead nộp task của chính mình / nhân viên thường → phải chờ review
            await this.reviewService.initializeReviews(task.id);
        }

        const recipientIds = getTaskSubmissionReviewRecipientIds(task, currentId);
        const isSelfAssigned = task.assignerId === task.assigneeId;

        const sheetNames = checkOptions.sheetNames?.length ? checkOptions.sheetNames : task.result.sheetNames;
        const scenarioLabels = checkOptions.scenarioLabels?.length ? checkOptions.scenarioLabels : task.result.scenarioLabels;
        const submissionDetails = buildSubmissionDetails(sheetNames, scenarioLabels);
        for (const recipientId of recipientIds) {
            const recipient = await this.userRepository.findOneBy({ id: recipientId });
            if (recipient) {
                await this.notificationService.createNotification({
                    title: "Kết quả công việc đã nộp",
                    content: isSelfAssigned
                        ? `${task.assignee?.fullName || 'Nhân viên'} đã nộp kết quả công việc tự phân công ${task.job?.name || ''}${submissionDetails}. Vui lòng kiểm tra để duyệt hoặc yêu cầu làm lại.`
                        : `${task.assignee?.fullName || 'Nhân viên'} đã nộp 1 task ${task.job?.name || ''}${submissionDetails}`,
                    type: "TASK_REVIEW",
                    recipient: recipient,
                    relatedEntityId: task.id.toString(),
                    relatedEntityType: "Task",
                    link: `/tasks/${task.id}`
                });
            }
        }

        const responseTask = shouldAutoApprove
            ? await this.taskRepository.findOne({ where: { id: task.id } }) || savedTask
            : savedTask;
        taskEmitter.emit(TASK_EVENTS.STATUS_CHANGED, responseTask);

        if (resultType === "FILE" || resultType === "LINK") {
            const resultMeta = task.result as any;
            const checkFileUrl = checkOptions.checkFileUrl || resultMeta.checkFileUrl || task.result?.url;
            const checkFileName = checkOptions.checkFileName || resultMeta.checkFileName || task.result?.name;
            void this.resultCheckService.startForSubmission({
                taskId: task.id,
                projectId: task.project?.id,
                fileBuffer: checkOptions.fileBuffer,
                fileUrl: checkOptions.fileBuffer ? undefined : checkFileUrl,
                fileName: checkFileName,
                sheetNames: sheetNames || [],
                whitelist: checkOptions.whitelist || [],
                scenarioIds: checkOptions.scenarioIds || [],
                actor: currentUser
            });
        }

        return responseTask;
    }

    async requestRework(id: string, data: {
        feedback: string,
        deadlineAt: Date,
        attachments?: any[]
    }, currentUser?: { id: string, userId?: string; role?: string }) {
        return await AppDataSource.transaction(async (transactionalEntityManager) => {
            const task = await transactionalEntityManager.findOne(Tasks, {
                where: { id },
                relations: ["assignee", "helper", "assigner", "contractService", "opportunity", "opportunity.createdBy", "opportunityServiceJob", "project", "project.team", "project.team.teamLead", "project.team.members", "project.team.members.user"]
            });

            if (!task) throw new Error("Không tìm thấy công việc");
            this.assertTaskProjectNotOnHold(task);
            const currentUserId = await this.resolveActorUserId(currentUser, transactionalEntityManager);
            const isOpportunityDemo = Boolean(task.opportunityId && task.opportunityServiceJob?.isBriefVideo);
            const isDemoSalesOwner = [UserRole.BD, UserRole.ADMIN_SALE].includes(currentUser?.role as UserRole) &&
                task.opportunity?.createdBy?.id === currentUserId;
            const isDemoAdmin = [UserRole.ADMIN, UserRole.BOD].includes(currentUser?.role as UserRole);
            const canRequestRework = isOpportunityDemo
                ? isDemoSalesOwner || isDemoAdmin
                : canDecideTaskOutcome(task, currentUserId);
            if (!canRequestRework) {
                throw this.httpError("Bạn không có quyền yêu cầu làm lại công việc này", 403);
            }

            // Status Guard: Only allow rework from review or completed states
            const allowedStatuses = [TaskStatus.AWAITING_REVIEW, TaskStatus.INTERNAL_COMPLETED, TaskStatus.COMPLETED];
            if (!allowedStatuses.includes(task.status)) {
                throw new Error(`Không thể yêu cầu làm lại cho công việc đang ở trạng thái hiện tại`);
            }

            // 1. Create Iteration Record (Snapshot current state)
            const iterationCount = await transactionalEntityManager.count(Tasks.name === "TaskIterations" ? "TaskIterations" : "task_iterations", {
                where: { taskId: task.id }
            } as any);

            const resultCheckRepository = transactionalEntityManager.getRepository(TaskResultChecks);
            const resultCheck = await resultCheckRepository.findOne({ where: { taskId: task.id } });
            const confirmedSpellErrors = resultCheck?.finalizedAt
                ? (resultCheck.reviewedSpellErrors || []).filter(e => e.confirmed)
                : [];
            const confirmedQcMismatches = resultCheck?.finalizedAt
                ? (resultCheck.reviewedQcMismatches || []).filter(m => m.status !== "unresolved" && m.confirmed)
                : [];

            const iterationRepository = transactionalEntityManager.getRepository("TaskIterations");
            const iteration = iterationRepository.create({
                task: task,
                version: iterationCount + 1,
                submittedResult: task.result,
                leadFeedback: data.feedback,
                feedbackAttachments: data.attachments,
                deadlineAt: data.deadlineAt,
                submittedById: task.lastSubmittedById,
                confirmedSpellErrors,
                confirmedQcMismatches
            });
            await iterationRepository.save(iteration);

            // Record violations for rework
            const currentIterationVersion = iterationCount + 1;

            // Case 2: Excessive Rework (3rd submission onwards by same person)
            if (currentIterationVersion >= 2) { // currentIterationVersion is count of PREVIOUS iterative submissions
                if (iterationCount >= 2 && task.lastSubmittedById) {
                    await this.recordViolation({
                        taskId: task.id,
                        userId: task.lastSubmittedById,
                        type: ViolationType.EXCESSIVE_REWORK,
                        description: `Nộp lại task lần thứ ${iterationCount + 1}.`,
                        iterationVersion: iterationCount + 1,
                        manager: transactionalEntityManager
                    });
                }
            }

            // Case 1: Late Unfinished (Overdue at point of rework request)
            if (task.plannedEndDate && new Date() > task.plannedEndDate && task.assigneeId) {
                await this.recordViolation({
                    taskId: task.id,
                    userId: task.assigneeId,
                    type: ViolationType.LATE_UNFINISHED,
                    description: `Yêu cầu làm lại khi task đã quá hạn.`,
                    manager: transactionalEntityManager
                });
            }

            // 1.5. Clean up old reviews (as requested by user)
            await transactionalEntityManager.delete(TaskReviews, { task: { id } });

            // 1.6. Reset ContractService if linked
            if (task.contractService) {
                const contractServiceRepository = transactionalEntityManager.getRepository(ContractServices);
                const cs = await contractServiceRepository.findOneBy({ id: task.contractService.id });
                if (cs && cs.results) {
                    // Remove or update the result for this specific task
                    cs.results = cs.results.filter(r => r.taskId !== task.id);
                    cs.status = ContractServiceStatus.ACTIVE;
                    await contractServiceRepository.save(cs);
                }
            }

            // 2. Update Task
            task.status = TaskStatus.REWORKING;
            task.customerDecision = null;

            if (data.deadlineAt && task.parentTaskId) {
                const parent = await transactionalEntityManager.findOne(Tasks, {
                    where: { id: task.parentTaskId },
                    select: ["id", "name", "plannedEndDate"]
                });
                if (parent?.plannedEndDate) {
                    assertSubtaskDeadlineNotExceedParent(new Date(data.deadlineAt), parent.plannedEndDate, task.name, parent.name);
                }
            }

            task.plannedEndDate = data.deadlineAt;
            task.result = null as any;

            const savedTask = await transactionalEntityManager.save(task);

            // 3. Notify Assignee
            if (task.assignee) {
                const checkSummary = buildCheckSummary(confirmedSpellErrors, confirmedQcMismatches);
                const feedbackContent = `Bạn có yêu cầu làm lại cho: ${this.taskDisplayName(task)} của dự án ${task.project?.name} (Mã: ${task.code}). Feedback: ${data.feedback}`;
                await this.notificationService.createNotification({
                    title: "Yêu cầu làm lại công việc",
                    content: checkSummary ? `${feedbackContent}\nLỗi đã chốt ở bản nộp trước:\n${checkSummary}` : feedbackContent,
                    type: "TASK_ASSIGNED",
                    recipient: task.assignee,
                    relatedEntityId: task.id.toString(),
                    relatedEntityType: "Task",
                    link: `/tasks/${task.id}`
                }, transactionalEntityManager);
            }

            taskEmitter.emit(TASK_EVENTS.STATUS_CHANGED, savedTask);

            return savedTask;
        });
    }

    async approveByCustomer(
        id: string,
        currentUser?: { id: string; userId?: string; role: string }
    ) {
        return this.completeCustomerDecision(id, "APPROVED", currentUser);
    }

    async customerDoesNotPurchase(
        id: string,
        currentUser?: { id: string; userId?: string; role: string }
    ) {
        return this.completeCustomerDecision(id, "NOT_PURCHASED", currentUser);
    }

    private async completeCustomerDecision(
        id: string,
        decision: "APPROVED" | "NOT_PURCHASED",
        currentUser?: { id: string; userId?: string; role: string }
    ) {
        const savedTask = await AppDataSource.transaction(async (manager) => {
            const currentUserId = await this.resolveActorUserId(currentUser, manager);
            if (!currentUserId) throw this.httpError("Bạn cần đăng nhập để xác nhận công việc", 401);

            const lockedTask = await manager.createQueryBuilder(Tasks, "task")
                .select("task.id")
                .where("task.id = :id", { id })
                .setLock("pessimistic_write")
                .getOne();
            if (!lockedTask) throw this.httpError("Không tìm thấy công việc", 404);

            const task = await manager.getRepository(Tasks).findOne({
                where: { id },
                relations: [
                    "assignee",
                    "assignee.accounts",
                    "helper",
                    "assigner",
                    "job",
                    "opportunityServiceJob",
                    "opportunityServiceJob.opportunityService",
                    "opportunity",
                    "opportunity.createdBy",
                    "project",
                    "project.team",
                    "project.team.teamLead",
                    "project.team.members",
                    "project.team.members.user"
                ]
            });
            if (!task) throw this.httpError("Không tìm thấy công việc", 404);
            this.assertTaskProjectNotOnHold(task);

            const isOpportunityDemo = Boolean(
                task.opportunityId && task.opportunityServiceJob?.isBriefVideo
            );
            if (decision === "NOT_PURCHASED" && !isOpportunityDemo) {
                throw this.httpError("Chỉ công việc Video AI demo mới có thể xác nhận khách hàng không mua", 409);
            }

            const isAdminOrBod = [UserRole.ADMIN, UserRole.BOD].includes(currentUser?.role as UserRole);
            const isSalesOwner = [UserRole.BD, UserRole.ADMIN_SALE].includes(currentUser?.role as UserRole) &&
                task.opportunity?.createdBy?.id === currentUserId;
            const canDecide = isOpportunityDemo
                ? (isSalesOwner || isAdminOrBod)
                : canDecideTaskOutcome(task, currentUserId);
            if (!canDecide) {
                throw this.httpError(
                    isOpportunityDemo
                        ? "Chỉ BD phụ trách cơ hội mới có quyền ghi nhận quyết định của khách hàng"
                        : "Bạn không có quyền xác nhận khách hàng duyệt công việc này",
                    403
                );
            }
            if (task.status !== TaskStatus.INTERNAL_COMPLETED) {
                throw this.httpError(`Công việc chưa ở trạng thái Hoàn thành nội bộ (Hiện tại: ${task.status})`, 409);
            }
            await assertSubtasksCompleted(manager.getRepository(Tasks), task, "hoàn thành");

            if (isOpportunityDemo) {
                task.customerDecision = decision;
                task.status = TaskStatus.ACCEPTED;

                const rewardAmount = Number(task.job?.vinicoin || 0);
                const assigneeAccount = task.assignee?.accounts?.find(account => account.isActive)
                    || task.assignee?.accounts?.[0];
                if (
                    task.performerType === PerformerType.INTERNAL &&
                    assigneeAccount?.id &&
                    rewardAmount > 0
                ) {
                    await this.vinicoinService.rewardForTask(
                        assigneeAccount.id,
                        rewardAmount,
                        task.id,
                        task.opportunityServiceJob!.opportunityServiceId,
                        manager
                    );
                    task.rewardVinicoin = rewardAmount;
                }
            } else {
                task.status = TaskStatus.COMPLETED;
            }

            const saved = await manager.save(task);
            if (task.assignee) {
                const customerMessage = decision === "NOT_PURCHASED"
                    ? "Khách hàng không mua; demo đã được nghiệm thu 0 đồng và Vinicoin đã được ghi nhận."
                    : isOpportunityDemo
                        ? "Khách hàng đã duyệt; demo đã được nghiệm thu 0 đồng và Vinicoin đã được ghi nhận."
                        : "Khách hàng đã duyệt công việc. Trạng thái: Hoàn thành.";
                await this.notificationService.createNotification({
                    title: decision === "NOT_PURCHASED" ? "Khách hàng không mua" : "Khách hàng đã duyệt",
                    content: `${customerMessage} Công việc: ${this.taskDisplayName(task)}.`,
                    type: "TASK_COMPLETED",
                    recipient: task.assignee,
                    relatedEntityId: task.id.toString(),
                    relatedEntityType: "Task",
                    link: `/tasks/${task.id}`
                }, manager);
            }
            return saved;
        });

        taskEmitter.emit(TASK_EVENTS.STATUS_CHANGED, savedTask);
        if (savedTask.opportunityId) {
            await RedisService.deleteCache(`opportunities:*:detail:${savedTask.opportunityId}*`);
        }
        return savedTask;
    }
}
