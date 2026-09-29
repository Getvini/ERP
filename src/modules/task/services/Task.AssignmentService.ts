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
import { isProjectManagementRole, UserRole } from "../../account/entities/Account.entity";
import { PaymentRequestService } from "../../payment-request/services/PaymentRequest.Service";

import { TaskBaseService } from "./Task.BaseService";
import { assertSubtasksCompleted } from "../helpers/SubtaskCompletion.helper";
import { assertSubtaskPlanApproved } from "../helpers/SubtaskPlanApproval.helper";
import {
    assertSubtaskDeadlineNotExceedParent,
    assertParentDeadlineNotBeforeSubtasks
} from "../helpers/SubtaskDeadline.helper";

const STATUSES_RESET_ON_PERFORMER_CHANGE = [
    TaskStatus.DOING,
    TaskStatus.REWORKING,
    TaskStatus.OVERDUE,
    TaskStatus.REJECTED
];

const getVietnamCalendarDateKey = (date: Date) => {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Ho_Chi_Minh",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
};

export class TaskAssignmentService extends TaskBaseService {
    async start(id: string, currentUser?: { id: string; userId?: string; role?: string }) {
        const task = await this.taskRepository.findOne({
            where: { id },
            relations: [
                "project",
                "project.team",
                "project.team.teamLead",
                "project.team.members",
                "project.team.members.user",
                "assignee",
                "helper",
                "assigner",
                "supervisor"
            ]
        });

        if (!task) throw this.httpError("Không tìm thấy công việc", 404);
        this.assertTaskProjectNotOnHold(task);
        await assertSubtaskPlanApproved(this.taskRepository, task, "bắt đầu công việc");
        if (task.status !== TaskStatus.NOT_STARTED) {
            throw this.httpError("Chỉ có thể bắt đầu công việc đang ở trạng thái Chưa thực hiện", 409);
        }

        const actorUserId = await this.resolveActorUserId(currentUser);
        const isPerformer = Boolean(actorUserId) && [task.assigneeId, task.helperId].includes(actorUserId as string);
        if (!isPerformer) {
            throw this.httpError("Chỉ người được giao công việc mới có thể bắt đầu", 403);
        }

        task.status = TaskStatus.DOING;
        task.actualStartDate = new Date();
        const saved = await this.taskRepository.save(task);
        await this.notifyTaskRecipients(saved, {
            title: "Công việc đã bắt đầu",
            content: `${task.assignee?.fullName || "Người thực hiện"} đã bắt đầu công việc: ${this.taskDisplayName(task)}${task.project?.name ? ` của dự án ${task.project.name}` : ""}.`,
            type: "TASK_STARTED"
        }, {
            excludeUserId: actorUserId
        });
        taskEmitter.emit(TASK_EVENTS.UPDATED, saved);
        return saved;
    }

    async bulkStart(
        projectId: string,
        taskIds: string[],
        currentUser?: { id: string; userId?: string; role?: string }
    ) {
        const actorUserId = await this.resolveActorUserId(currentUser);
        if (!actorUserId) throw this.httpError("Bạn cần đăng nhập để bắt đầu công việc", 401);

        const result = await AppDataSource.transaction(async (transactionalEntityManager) => {
            const project = await transactionalEntityManager.findOne(Projects, {
                where: { id: projectId }
            });
            if (!project) throw this.httpError("Không tìm thấy dự án", 404);
            this.assertTaskProjectNotOnHold({ project });

            if (![ProjectStatus.CONFIRMED, ProjectStatus.IN_PROGRESS].includes(project.status)) {
                throw this.httpError("Dự án không ở trạng thái cho phép bắt đầu công việc", 400);
            }

            const uniqueTaskIds = [...new Set(taskIds)].sort();
            for (const taskId of uniqueTaskIds) {
                await transactionalEntityManager.findOne(Tasks, {
                    where: { id: taskId },
                    lock: { mode: "pessimistic_write" }
                });
            }

            const tasks = await transactionalEntityManager.find(Tasks, {
                where: { id: In(uniqueTaskIds) },
                relations: ["project"]
            });
            const taskById = new Map(tasks.map(task => [task.id, task]));
            const started: Tasks[] = [];
            const skipped: { id: string; code?: string; reason: string }[] = [];
            const startedAt = new Date();
            const taskRepository = transactionalEntityManager.getRepository(Tasks);

            for (const id of uniqueTaskIds) {
                const task = taskById.get(id);
                if (!task) {
                    skipped.push({ id, reason: "Không tìm thấy công việc" });
                    continue;
                }

                const skip = (reason: string) => skipped.push({
                    id: task.id,
                    code: task.code || undefined,
                    reason
                });

                if (task.project?.id !== projectId) {
                    skip("Công việc không thuộc dự án hiện tại");
                    continue;
                }
                if (task.status !== TaskStatus.NOT_STARTED) {
                    skip("Công việc không còn ở trạng thái Chưa thực hiện");
                    continue;
                }
                if (task.assigneeId !== actorUserId) {
                    skip("Bạn không phải người thực hiện chính của công việc");
                    continue;
                }

                try {
                    await assertSubtaskPlanApproved(taskRepository, task, "bắt đầu công việc");
                } catch (error: any) {
                    if (error.statusCode === 409) {
                        skip(error.message);
                        continue;
                    }
                    throw error;
                }

                task.status = TaskStatus.DOING;
                task.actualStartDate = startedAt;
                started.push(await transactionalEntityManager.save(task));
            }

            return { started, skipped };
        });

        result.started.forEach(task => taskEmitter.emit(TASK_EVENTS.UPDATED, task));
        return result;
    }

    private paymentRequestService = new PaymentRequestService();
    async updateNickname(
        id: string,
        nickname: string | null | undefined,
        currentUser?: { id: string; userId?: string; role: string }
    ) {
        const task = await this.taskRepository.findOne({
            where: { id },
            relations: ["project", "project.team", "project.team.teamLead", "project.team.members", "project.team.members.user"]
        });

        if (!task) throw this.httpError("Không tìm thấy công việc", 404);
        this.assertTaskNotLocked(task);

        const currentUserId = currentUser?.userId || currentUser?.id;
        const isAdminOrBod = isProjectManagementRole(currentUser?.role);
        const isProjectLead = this.isProjectOperatorFromTeam(task.project?.team, currentUser);

        if (!isAdminOrBod && !isProjectLead) {
            throw this.httpError("Bạn không có quyền thay đổi nickname của công việc này", 403);
        }
        if (nickname === undefined) throw this.httpError("Vui lòng cung cấp nickname", 400);
        if (nickname != null && typeof nickname !== "string") throw this.httpError("Nickname không hợp lệ", 400);

        const normalizedNickname = nickname?.trim() || null;
        if (normalizedNickname && normalizedNickname.length > 120) {
            throw this.httpError("Nickname không được vượt quá 120 ký tự", 400);
        }

        task.nickname = normalizedNickname;
        const saved = await this.taskRepository.save(task);
        await this.notifyTaskRecipients(saved, {
            title: "Nickname công việc đã được cập nhật",
            content: `Công việc ${task.code ? `${task.code} - ` : ""}${task.name} đã được cập nhật nickname thành "${normalizedNickname || task.name}".`,
            type: "TASK_UPDATED"
        }, {
            includePerformers: true,
            excludeUserId: currentUserId
        });
        taskEmitter.emit(TASK_EVENTS.UPDATED, saved);
        return saved;
    }

    async update(id: string, data: Partial<Tasks> & { assigneeId?: string }, currentUser?: { id: string, userId?: string; role?: string }) {
        const task = await this.getOne(id);
        this.assertTaskNotLocked(task);
        await assertSubtaskPlanApproved(this.taskRepository, task, "cập nhật subtask");

        if (data.assigneeId !== undefined && data.assigneeId !== task.assigneeId) {
            throw this.httpError("Vui lòng dùng chức năng phân công hoặc chuyển giao để thay đổi người thực hiện", 400);
        }
        if (task.status === TaskStatus.NOT_STARTED && data.status && data.status !== TaskStatus.NOT_STARTED) {
            throw this.httpError("Vui lòng dùng chức năng Bắt đầu công việc để chuyển sang Đang thực hiện", 409);
        }
        if (task.status === TaskStatus.PENDING && data.status === TaskStatus.DOING) {
            throw this.httpError("Cần phân công người thực hiện trước khi bắt đầu công việc", 409);
        }
        if (task.status === TaskStatus.NOT_STARTED && data.actualStartDate) {
            throw this.httpError("Ngày bắt đầu thực tế chỉ được ghi khi bắt đầu công việc", 409);
        }

        const completionStatuses = [
            TaskStatus.AWAITING_REVIEW,
            TaskStatus.INTERNAL_COMPLETED,
            TaskStatus.COMPLETED,
            TaskStatus.ACCEPTED
        ];
        if (data.result || (data.status && completionStatuses.includes(data.status))) {
            await assertSubtasksCompleted(
                this.taskRepository,
                task,
                data.result ? "nộp kết quả" : "hoàn thành"
            );
        }

        if (data.status) task.status = data.status;
        if (data.description !== undefined) task.description = data.description;
        if (data.plannedStartDate) task.plannedStartDate = data.plannedStartDate;
        if (data.plannedEndDate) {
            const newDeadline = new Date(data.plannedEndDate);
            if (task.parentTaskId) {
                const parent = await this.taskRepository.findOne({
                    where: { id: task.parentTaskId },
                    select: ["id", "name", "plannedEndDate"]
                });
                if (parent?.plannedEndDate) {
                    assertSubtaskDeadlineNotExceedParent(newDeadline, parent.plannedEndDate, task.name, parent.name);
                }
            } else {
                const subtasks = await this.taskRepository.find({
                    where: { parentTaskId: task.id },
                    select: ["id", "name", "plannedEndDate"]
                });
                assertParentDeadlineNotBeforeSubtasks(newDeadline, subtasks, task.name);
            }
            task.plannedEndDate = data.plannedEndDate;
        }
        if (data.actualStartDate) task.actualStartDate = data.actualStartDate;
        if (data.actualEndDate) task.actualEndDate = data.actualEndDate;
        if (data.result) {
            task.result = data.result;

            // Re-fetch to ensure we have lead info
            const taskWithInfo = await this.taskRepository.findOne({
                where: { id: task.id },
                relations: ["project", "project.team", "project.team.teamLead", "project.team.members", "project.team.members.user"]
            });

            const isTeamLead = this.isProjectOperatorFromTeam(taskWithInfo?.project?.team, currentUser);

            if (isTeamLead) {
                task.status = TaskStatus.AWAITING_REVIEW;
                task.actualEndDate = new Date();
                await this.taskRepository.save(task);

                await this.reviewService.initializeReviews(task.id, true);
                await this.reviewService.checkAndFinalize(task.id, undefined, undefined, currentUser);
                task.status = TaskStatus.INTERNAL_COMPLETED;
            } else {
                task.status = TaskStatus.AWAITING_REVIEW;
                await this.taskRepository.save(task);

                if (taskWithInfo && taskWithInfo.project?.team?.teamLead) {
                    await this.reviewService.initializeReviews(task.id);

                    await this.notificationService.createNotification({
                        title: "Công việc chờ duyệt",
                        content: `Nhân viên đã upload kết quả cho công việc: ${this.taskDisplayName(task)} của dự án ${task.project?.name}. Vui lòng đánh giá.`,
                        type: "TASK_REVIEW",
                        recipient: taskWithInfo.project.team.teamLead,
                        relatedEntityId: task.id.toString(),
                        relatedEntityType: "Task",
                        link: `/tasks/${task.id}`
                    });
                }
            }
        }

        const saved = await this.taskRepository.save(task);
        if (!data.result) {
            const actorUserId = await this.resolveActorUserId(currentUser);
            await this.notifyTaskRecipients(saved, {
                title: "Công việc đã được cập nhật",
                content: `Công việc ${this.taskDisplayName(saved)}${saved.project?.name ? ` của dự án ${saved.project.name}` : ""} vừa được cập nhật.`,
                type: "TASK_UPDATED"
            }, {
                includePerformers: true,
                excludeUserId: actorUserId
            });
        }
        taskEmitter.emit(TASK_EVENTS.UPDATED, saved);
        return saved;
    }

    async bulkAssign(taskIds: string[], data: {
        assigneeId: string;
        performerType?: PerformerType;
        plannedEndDate: Date;
        plannedStartDate?: Date;
        description?: string;
        attachments?: { type: string, name: string, url: string, size?: number, publicId?: string }[];
    }, currentUser?: { id: string; userId?: string; role?: string }) {
        const plannedEndDate = data.plannedEndDate ? new Date(data.plannedEndDate) : null;
        if (!plannedEndDate || Number.isNaN(plannedEndDate.getTime())) {
            throw this.httpError("Vui lòng nhập deadline", 400);
        }
        const now = new Date();
        now.setSeconds(0, 0);
        if (plannedEndDate.getTime() < now.getTime() - 60 * 1000) {
            throw this.httpError("Deadline không được ở trong quá khứ", 400);
        }
        const uniqueTaskIds = [...new Set(taskIds)].sort();

        // Chặn trước khi mở transaction: nếu BẤT KỲ task nào thuộc dự án ON_HOLD
        // thì chặn toàn bộ, không ghi nửa vời.
        await this.assertProjectNotOnHoldForTasks(uniqueTaskIds);

        const vendorExpenseTasks: { projectId: string; taskId: string; vendorId: string; vendorName: string; taskName: string; taskCode?: string | null; projectName?: string; amount: number; dueDate: Date; requesterId: string }[] = [];

        const results = await AppDataSource.transaction(async (transactionalEntityManager) => {
            const assignedAt = new Date();
            const results = [];
            const contractCostUpdates = new Map<string, number>();

            for (const id of uniqueTaskIds) {
                // Khóa hàng trước khi đọc đầy đủ quan hệ để hai Lead không thể
                // đồng thời nhận quyền phân công cùng một task.
                await transactionalEntityManager.findOne(Tasks, {
                    where: { id },
                    lock: { mode: "pessimistic_write" }
                });
                const task = await transactionalEntityManager.findOne(Tasks, {
                    where: { id },
                    relations: ["project", "project.contract", "project.team", "project.team.teamLead", "project.team.members", "project.team.members.user", "opportunity", "opportunityServiceJob", "job"]
                });
                if (!task) continue;
                await assertSubtaskPlanApproved(
                    transactionalEntityManager.getRepository(Tasks),
                    task,
                    "phân công subtask"
                );

                const plannedStartDate = task.plannedStartDate
                    ? new Date(task.plannedStartDate)
                    : assignedAt;

                const oldCost = Number(task.cost || 0);
                let newCost = 0;
                let assignedVendor: Vendors | null = null;
                const isVideoDemoTask = Boolean(task.opportunityServiceJob?.isBriefVideo);

                const isSupportAssign = task.supportRequestType !== "STAFFING" && task.isSupportRequested && task.supportLeadId && task.isSupportAccepted && currentUser &&
                    (task.supportLeadId === currentUser.id || (currentUser as any).userId === task.supportLeadId);

                if (isSupportAssign) {
                    const user = await transactionalEntityManager.findOneBy(Users, { id: data.assigneeId });
                    if (!user) throw new Error("Người hỗ trợ không tồn tại");

                    task.helperId = data.assigneeId;
                    task.status = TaskStatus.DOING;
                    task.isSupportReturnRequested = false;

                    await this.notificationService.createNotification({
                        title: "Bạn được giao hỗ trợ công việc",
                        content: `Bạn được giao hỗ trợ công việc: ${this.taskDisplayName(task)} của dự án ${task.project?.name} (Mã: ${task.code})`,
                        type: "TASK_ASSIGNED",
                        recipient: user,
                        relatedEntityId: task.id.toString(),
                        relatedEntityType: "Task",
                        link: `/tasks/${task.id}`
                    }, transactionalEntityManager);
                } else {
                    const hadMainPerformer = Boolean(task.assigneeId || task.vendor);
                    const actorUserId = await this.assertCanManageTaskAssignment(
                        task,
                        currentUser,
                        transactionalEntityManager
                    );

                    // Clear support fields when reassigning the main performer
                    task.isSupportRequested = false;
                    task.isSupportAccepted = false;
                    task.supportTeamId = null as any;
                    task.supportLeadId = null as any;
                    task.helperId = null as any;
                    task.isSupportReturnRequested = false;
                    task.supportRequestNote = null as any;
                    task.supportReturnNote = null as any;
                    task.supportRequestType = null;

                    if (isVideoDemoTask && data.performerType === PerformerType.VENDOR) {
                        throw this.httpError("Video AI demo chỉ được phân công cho nhân viên nội bộ", 400);
                    }

                    if (data.performerType === PerformerType.VENDOR) {
                        const vendor = await transactionalEntityManager.findOneBy(Vendors, { id: data.assigneeId });
                        if (!vendor) throw new Error("Vendor không tồn tại");

                        const vendorJob = await transactionalEntityManager.findOneBy(VendorJobs, {
                            vendor: { id: vendor.id },
                            job: { id: task.job.id }
                        });

                        if (!vendorJob) {
                            throw new Error(`Vendor ${vendor.name} chưa được thiết lập giá cho hạng mục ${task.job.name}`);
                        }

                        newCost = Number(vendorJob.price);
                        task.vendor = vendor;
                        task.assignee = null as any;
                        task.performerType = PerformerType.VENDOR;
                        task.cost = newCost;
                        assignedVendor = vendor;
                    } else {
                        const user = await transactionalEntityManager.findOne(Users, {
                            where: { id: data.assigneeId },
                            relations: isVideoDemoTask ? ["accounts"] : []
                        });
                        if (!user) throw new Error("Người thực hiện không tồn tại");
                        if (isVideoDemoTask && (user.isLocked || !user.accounts?.some(account => account.isActive))) {
                            throw this.httpError("Chỉ có thể phân công Video AI demo cho nhân viên đang hoạt động", 400);
                        }
                        task.assignee = user;
                        task.vendor = null as any;
                        task.performerType = PerformerType.INTERNAL;
                        task.cost = 0;

                        await this.notificationService.createNotification({
                            title: "Công việc mới được giao",
                            content: isVideoDemoTask
                                ? `Bạn được giao làm Video AI demo cho cơ hội ${task.opportunity?.name || task.opportunity?.opportunityCode || ""} (Mã task: ${task.code})`
                                : `Bạn được giao công việc: ${this.taskDisplayName(task)} của dự án ${task.project?.name} (Mã: ${task.code})`,
                            type: "TASK_ASSIGNED",
                            recipient: user,
                            relatedEntityId: task.id.toString(),
                            relatedEntityType: "Task",
                            link: `/tasks/${task.id}`
                        }, transactionalEntityManager);
                    }

                    if (task.status === TaskStatus.PENDING || task.status === TaskStatus.AWAITING_SUPPORT) {
                        task.status = task.status === TaskStatus.PENDING
                            ? TaskStatus.NOT_STARTED
                            : TaskStatus.DOING;
                        task.isSupportRequested = false;
                        task.isSupportAccepted = false;
                        task.supportLeadId = null as any;
                        task.supportRequestType = null;
                    }

                    if (STATUSES_RESET_ON_PERFORMER_CHANGE.includes(task.status)) {
                        task.status = TaskStatus.NOT_STARTED;
                        task.actualStartDate = null as any;
                    }

                    // Lead giao lần đầu (hoặc nhận task cũ chưa có chủ sở hữu)
                    // trở thành chủ của quyền phân công. ADMIN ghi đè task đã có
                    // chủ nhưng không chiếm quyền của Lead ban đầu.
                    if (!hadMainPerformer || !task.assignerId) {
                        task.assignerId = actorUserId;
                    }
                }

                if (task.parentTaskId) {
                    const parent = await transactionalEntityManager.findOne(Tasks, {
                        where: { id: task.parentTaskId },
                        select: ["id", "name", "plannedEndDate"]
                    });
                    if (parent?.plannedEndDate) {
                        assertSubtaskDeadlineNotExceedParent(plannedEndDate, parent.plannedEndDate, task.name, parent.name);
                    }
                } else {
                    const subtasks = await transactionalEntityManager.find(Tasks, {
                        where: { parentTaskId: task.id },
                        select: ["id", "name", "plannedEndDate"]
                    });
                    assertParentDeadlineNotBeforeSubtasks(plannedEndDate, subtasks, task.name);
                }

                task.plannedEndDate = plannedEndDate;
                task.plannedStartDate = plannedStartDate;
                if (data.description) task.description = data.description;
                if (data.attachments) task.attachments = data.attachments;

                if (!isSupportAssign && task.project?.contract) {
                    const contractId = task.project.contract.id;
                    const diff = newCost - oldCost;
                    contractCostUpdates.set(contractId, (contractCostUpdates.get(contractId) || 0) + diff);
                }

                if (currentUser) {
                    const assignerId = await this.resolveActorUserId(currentUser, transactionalEntityManager);
                    if (!assignerId) throw this.httpError("Tài khoản chưa được liên kết nhân sự để phân công công việc", 401);
                    task.assignerId = assignerId;
                }

                const savedTask = await transactionalEntityManager.save(task);
                results.push(savedTask);

                // Task giao cho vendor => tự động xem là chi phí phát sinh, chuẩn bị tạo yêu cầu thanh toán
                // điền sẵn thông tin theo dự án/công việc (thực hiện sau khi transaction commit thành công)
                if (assignedVendor && savedTask.project?.id && savedTask.assignerId) {
                    vendorExpenseTasks.push({
                        projectId: savedTask.project.id,
                        taskId: savedTask.id,
                        vendorId: assignedVendor.id,
                        vendorName: assignedVendor.name,
                        taskName: this.taskDisplayName(savedTask),
                        taskCode: savedTask.code,
                        projectName: savedTask.project?.name,
                        amount: newCost,
                        dueDate: plannedEndDate,
                        requesterId: savedTask.assignerId
                    });
                }
            }

            // Batch update contract costs
            for (const [contractId, diff] of contractCostUpdates.entries()) {
                if (diff !== 0) {
                    const contract = await transactionalEntityManager.findOneBy(Contracts, { id: contractId });
                    if (contract) {
                        contract.cost = Number(contract.cost || 0) + diff;
                        await transactionalEntityManager.save(contract);
                    }
                }
            }

            return results;
        });

        // Tạo yêu cầu thanh toán chi phí phát sinh (vendor) sau khi transaction phân công đã commit
        for (const item of vendorExpenseTasks) {
            try {
                await this.paymentRequestService.createVendorExpense(item);
            } catch (err) {
                // Không chặn việc phân công task nếu tạo yêu cầu thanh toán tự động thất bại
                console.error("Không thể tự động tạo yêu cầu thanh toán chi phí phát sinh cho vendor:", err);
            }
        }

        results.forEach(task => taskEmitter.emit(TASK_EVENTS.UPDATED, task));
        return results;
    }

    async assign(id: string, data: {
        assigneeId: string;
        performerType?: PerformerType;
        plannedEndDate: Date;
        plannedStartDate?: Date;
        description?: string;
        attachments?: { type: string, name: string, url: string, size?: number, publicId?: string }[];
    }, currentUser?: { id: string; userId?: string; role?: string }) {
        const results = await this.bulkAssign([id], data, currentUser);
        return results[0];
    }

    async bulkUnassign(
        projectId: string,
        taskIds: string[],
        currentUser?: { id: string; userId?: string; role: string }
    ) {
        const result = await AppDataSource.transaction(async (transactionalEntityManager) => {
            const project = await transactionalEntityManager.findOne(Projects, {
                where: { id: projectId },
                relations: ["team", "team.teamLead", "team.members", "team.members.user", "contract"]
            });

            if (!project) {
                throw this.httpError("Không tìm thấy dự án", 404);
            }

            this.assertTaskProjectNotOnHold({ project });

            if (![ProjectStatus.CONFIRMED, ProjectStatus.IN_PROGRESS].includes(project.status)) {
                throw this.httpError("Dự án không ở trạng thái cho phép xoá phân công", 400);
            }

            const currentUserId = currentUser?.userId || currentUser?.id;

            const uniqueTaskIds = [...new Set(taskIds)].sort();
            for (const taskId of uniqueTaskIds) {
                await transactionalEntityManager.findOne(Tasks, {
                    where: { id: taskId },
                    lock: { mode: "pessimistic_write" }
                });
            }
            const tasks = await transactionalEntityManager.find(Tasks, {
                where: { id: In(uniqueTaskIds) },
                relations: ["project", "assignee", "vendor", "reviews", "iterations"]
            });
            const taskById = new Map(tasks.map(task => [task.id, task]));
            const unassigned: Tasks[] = [];
            const skipped: { id: string; code?: string; reason: string }[] = [];
            let contractCostReduction = 0;

            for (const id of uniqueTaskIds) {
                const task = taskById.get(id);
                if (!task) {
                    skipped.push({ id, reason: "Không tìm thấy công việc" });
                    continue;
                }

                const skip = (reason: string) => {
                    skipped.push({ id: task.id, code: task.code, reason });
                };

                if (task.project?.id !== projectId) {
                    skipped.push({ id: task.id, reason: "Công việc không thuộc dự án hiện tại" });
                    continue;
                }
                task.project = project;
                if (![TaskStatus.NOT_STARTED, TaskStatus.DOING].includes(task.status)) {
                    skip("Công việc không ở trạng thái chưa thực hiện hoặc đang thực hiện");
                    continue;
                }
                if (!task.assigneeId && !task.vendor) {
                    skip("Công việc chưa có người hoặc vendor được phân công");
                    continue;
                }
                try {
                    await this.assertCanManageTaskAssignment(task, currentUser, transactionalEntityManager);
                } catch (error: any) {
                    if (error.statusCode === 409 || error.statusCode === 403) {
                        skip(error.message);
                        continue;
                    }
                    throw error;
                }
                if (task.result || task.actualStartDate || task.actualEndDate || task.lastSubmittedById) {
                    skip("Công việc đã phát sinh kết quả thực hiện");
                    continue;
                }
                if ((task.reviews?.length || 0) > 0 || (task.iterations?.length || 0) > 0) {
                    skip("Công việc đã phát sinh review hoặc lần làm lại");
                    continue;
                }

                const hasSupportActivity = task.isSupportRequested || task.isSupportAccepted ||
                    task.isSupportReturnRequested || Boolean(task.supportTeamId) ||
                    Boolean(task.supportLeadId) || Boolean(task.helperId) ||
                    Boolean(task.supportRequestNote) || Boolean(task.supportReturnNote);
                if (hasSupportActivity) {
                    skip("Công việc đã phát sinh luồng hỗ trợ");
                    continue;
                }

                try {
                    await this.paymentRequestService.cancelPendingForTask(task.id, currentUserId as string, transactionalEntityManager);
                } catch (err: any) {
                    skip(err.message || "Còn yêu cầu thanh toán chưa xử lý cho công việc này");
                    continue;
                }

                const oldAssignee = task.assignee;

                contractCostReduction += Number(task.cost || 0);
                task.status = TaskStatus.PENDING;
                task.spentAmount = 0;
                task.assignee = null as any;
                task.assigneeId = null as any;
                task.vendor = null as any;
                task.assigner = null as any;
                task.assignerId = null as any;
                task.performerType = PerformerType.INTERNAL;
                task.plannedStartDate = null as any;
                task.plannedEndDate = null as any;
                task.actualStartDate = null as any;
                task.actualEndDate = null as any;
                task.description = null as any;
                task.attachments = null as any;
                task.result = null as any;
                task.reassignNote = null as any;
                task.reviewNote = null as any;
                task.cost = 0;
                task.lastSubmittedById = null as any;
                task.lastSubmittedBy = null as any;
                task.isSupportRequested = false;
                task.isSupportAccepted = false;
                task.isSupportReturnRequested = false;
                task.supportTeamId = null as any;
                task.supportLeadId = null as any;
                task.helperId = null as any;
                task.helper = null as any;
                task.supportRequestNote = null as any;
                task.supportReturnNote = null as any;

                unassigned.push(await transactionalEntityManager.save(task));

                if (oldAssignee) {
                    await this.notificationService.createNotification({
                        title: "Công việc đã được gỡ phân công",
                        content: `Bạn đã được gỡ khỏi công việc: ${this.taskDisplayName(task)} của dự án ${project.name}${task.code ? ` (Mã: ${task.code})` : ""}.`,
                        type: "TASK_UNASSIGNED",
                        recipient: oldAssignee,
                        relatedEntityId: task.id.toString(),
                        relatedEntityType: "Task",
                        link: `/tasks/${task.id}`
                    }, transactionalEntityManager);
                }
            }

            if (project.contract && contractCostReduction !== 0) {
                await transactionalEntityManager.decrement(
                    Contracts,
                    { id: project.contract.id },
                    "cost",
                    contractCostReduction
                );
            }

            return { unassigned, skipped };
        });

        result.unassigned.forEach(task => taskEmitter.emit(TASK_EVENTS.UPDATED, task));
        return result;
    }

    async reassign(id: string, data: {
        assigneeId: string;
        performerType: PerformerType;
        reason: string;
    }, currentUser: { id: string; userId?: string; role?: string }) {
        let assignedVendor: Vendors | null = null;
        let newCost = 0;

        const savedTask = await AppDataSource.transaction(async (manager) => {
            await manager.findOne(Tasks, {
                where: { id },
                lock: { mode: "pessimistic_write" }
            });
            const task = await manager.findOne(Tasks, {
                where: { id },
                relations: ["project", "project.contract", "project.team", "project.team.teamLead", "project.team.members", "project.team.members.user", "job", "assignee", "vendor"]
            });

            if (!task) throw this.httpError("Không tìm thấy công việc", 404);
            this.assertTaskProjectNotOnHold(task);

            const oldAssigneeId = task.assigneeId;
            let oldRecipient: Users | null = null;
            if (task.performerType === PerformerType.INTERNAL && task.assignee) {
                oldRecipient = task.assignee;
            }

            const oldCost = Number(task.cost || 0);
            let newPerformerName = "";
            let newRecipient: Users | null = null;

            await this.paymentRequestService.cancelPendingForTask(task.id, currentUser?.userId || currentUser?.id || "system", manager);

            const isSupportReassign = task.supportRequestType !== "STAFFING" && task.isSupportRequested && task.isSupportAccepted &&
                (task.supportLeadId === currentUser.id || currentUser.userId === task.supportLeadId);

            if (isSupportReassign) {
                const user = await manager.findOneBy(Users, { id: data.assigneeId });
                if (!user) throw this.httpError("Người hỗ trợ không tồn tại", 404);

                task.helperId = data.assigneeId;
                task.isSupportReturnRequested = false;
                newPerformerName = user.fullName;
                newRecipient = user;
            } else {
                const actorUserId = await this.assertCanManageTaskAssignment(task, currentUser, manager);

                if (STATUSES_RESET_ON_PERFORMER_CHANGE.includes(task.status)) {
                    task.status = TaskStatus.NOT_STARTED;
                    task.actualStartDate = null as any;
                }
                if (task.status === TaskStatus.AWAITING_SUPPORT) task.status = TaskStatus.DOING;
                task.isSupportRequested = false;
                task.isSupportAccepted = false;
                task.supportTeamId = null as any;
                task.supportLeadId = null as any;
                task.helperId = null as any;
                task.isSupportReturnRequested = false;
                task.supportRequestNote = null as any;
                task.supportReturnNote = null as any;
                task.supportRequestType = null;

                if (data.performerType === PerformerType.VENDOR) {
                    const vendor = await manager.findOneBy(Vendors, { id: data.assigneeId });
                    if (!vendor) throw this.httpError("Vendor không tồn tại", 404);

                    const vendorJob = await manager.findOneBy(VendorJobs, {
                        vendor: { id: vendor.id },
                        job: { id: task.job.id }
                    });
                    if (!vendorJob) {
                        throw this.httpError(`Vendor ${vendor.name} chưa được thiết lập giá cho hạng mục ${task.job.name}`, 400);
                    }

                    newCost = Number(vendorJob.price);
                    newPerformerName = vendor.name;
                    task.vendor = vendor;
                    task.assignee = null as any;
                    task.performerType = PerformerType.VENDOR;
                    task.cost = newCost;
                    task.spentAmount = 0;
                    assignedVendor = vendor;
                } else {
                    const user = await manager.findOneBy(Users, { id: data.assigneeId });
                    if (!user) throw this.httpError("Người thực hiện không tồn tại", 404);

                    newPerformerName = user.fullName;
                    newRecipient = user;
                    task.assignee = user;
                    task.vendor = null as any;
                    task.performerType = PerformerType.INTERNAL;
                    task.cost = 0;
                    task.spentAmount = 0;
                }

                // Task legacy chưa có chủ sở hữu sẽ thuộc Lead thực hiện lần chuyển giao này.
                // ADMIN thay đổi task đã có chủ vẫn giữ nguyên assignerId ban đầu.
                if (!task.assignerId) task.assignerId = actorUserId;

                if (task.plannedEndDate && new Date() > task.plannedEndDate && oldAssigneeId) {
                    await this.recordViolation({
                        taskId: task.id,
                        userId: oldAssigneeId,
                        type: ViolationType.LATE_UNFINISHED,
                        description: "Task quá hạn được chuyển giao cho người khác.",
                        manager
                    });
                }
            }

            task.reassignNote = data.reason;

            if (!isSupportReassign && oldCost !== newCost && task.project?.contract) {
                const contract = task.project.contract;
                contract.cost = Number(contract.cost || 0) - oldCost + newCost;
                await manager.save(contract);
            }

            const saved = await manager.save(task);

            if (oldRecipient) {
                await this.notificationService.createNotification({
                    title: "Công việc đã được chuyển giao",
                    content: `Công việc: ${this.taskDisplayName(task)} của dự án ${task.project?.name} (Mã: ${task.code}) đã được chuyển giao cho ${newPerformerName}`,
                    type: "TASK_REASSIGNED",
                    recipient: oldRecipient,
                    relatedEntityId: task.id.toString(),
                    relatedEntityType: "Task",
                }, manager);
            }

            if (newRecipient) {
                await this.notificationService.createNotification({
                    title: "Công việc được chuyển giao mới",
                    content: `Bạn được giao công việc: ${this.taskDisplayName(task)} của dự án ${task.project?.name} (Mã: ${task.code}).`,
                    type: "TASK_ASSIGNED",
                    recipient: newRecipient,
                    relatedEntityId: task.id.toString(),
                    relatedEntityType: "Task",
                    link: `/tasks/${task.id}`
                }, manager);
            }

            return saved;
        });

        // Task được chuyển giao cho vendor => tự động xem là chi phí phát sinh, tạo sẵn yêu cầu thanh toán
        if (assignedVendor && savedTask.project?.id && savedTask.assignerId) {
            try {
                await this.paymentRequestService.createVendorExpense({
                    projectId: savedTask.project.id,
                    taskId: savedTask.id,
                    vendorId: assignedVendor.id,
                    vendorName: assignedVendor.name,
                    taskName: this.taskDisplayName(savedTask),
                    taskCode: savedTask.code,
                    projectName: savedTask.project?.name,
                    amount: newCost,
                    dueDate: savedTask.plannedEndDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                    requesterId: savedTask.assignerId
                });
            } catch (err) {
                // Không chặn việc chuyển giao task nếu tạo yêu cầu thanh toán tự động thất bại
                console.error("Không thể tự động tạo yêu cầu thanh toán chi phí phát sinh cho vendor:", err);
            }
        }

        taskEmitter.emit(TASK_EVENTS.UPDATED, savedTask);
        return savedTask;
    }
}