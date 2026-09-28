import { Tasks } from "../entities/Task.entity";
import { PerformerType } from "../../../shared/entities/Enums";
import { TaskAssignmentService } from "./Task.AssignmentService";
import { TaskCreationService } from "./Task.CreationService";
import { TaskDeletionService } from "./Task.DeletionService";
import { TaskPricingService } from "./Task.PricingService";
import { TaskQueryService } from "./Task.QueryService";
import { TaskReminderService } from "./Task.ReminderService";
import { TaskResultService } from "./Task.ResultService";
import { TaskSupportService } from "./Task.SupportService";
import { TaskDelegationService } from "./Task.DelegationService";

export class TaskService {
    private queryService = new TaskQueryService();
    private creationService = new TaskCreationService();
    private assignmentService = new TaskAssignmentService();
    private resultService = new TaskResultService();
    private supportService = new TaskSupportService();
    private pricingService = new TaskPricingService();
    private deletionService = new TaskDeletionService();
    private reminderService = new TaskReminderService();
    private delegationService = new TaskDelegationService();

    getAll(filters: any = {}, userInfo?: { id: string, userId?: string, role: string }) {
        return this.queryService.getAll(filters, userInfo);
    }

    getOne(id: string, currentUser?: { id: string; userId?: string; role?: string }) {
        return this.queryService.getOne(id, currentUser);
    }

    getDailyWorkloadByAssignee(userId: string, startDate?: string, endDate?: string) {
        return this.queryService.getDailyWorkloadByAssignee(userId, startDate, endDate);
    }

    createInternalTask(data: Parameters<TaskCreationService["createInternalTask"]>[0], currentUser?: { id: string; userId?: string; role?: string }) {
        return this.creationService.createInternalTask(data, currentUser);
    }

    create(data: Parameters<TaskCreationService["create"]>[0], currentUser?: { id: string; userId?: string; role?: string }) {
        return this.creationService.create(data, currentUser);
    }

    updateNickname(id: string, nickname: string | null | undefined, currentUser?: { id: string; userId?: string; role: string }) {
        return this.assignmentService.updateNickname(id, nickname, currentUser);
    }

    update(id: string, data: Partial<Tasks> & { assigneeId?: string }, currentUser?: { id: string, userId?: string; role?: string }) {
        return this.assignmentService.update(id, data, currentUser);
    }

    start(id: string, currentUser?: { id: string; userId?: string; role?: string }) {
        return this.assignmentService.start(id, currentUser);
    }

    bulkStart(projectId: string, taskIds: string[], currentUser?: { id: string; userId?: string; role?: string }) {
        return this.assignmentService.bulkStart(projectId, taskIds, currentUser);
    }

    bulkAssign(taskIds: string[], data: Parameters<TaskAssignmentService["bulkAssign"]>[1], currentUser?: { id: string, userId?: string; role?: string }) {
        return this.assignmentService.bulkAssign(taskIds, data, currentUser);
    }

    assign(id: string, data: Parameters<TaskAssignmentService["assign"]>[1], currentUser?: { id: string, userId?: string; role?: string }) {
        return this.assignmentService.assign(id, data, currentUser);
    }

    bulkUnassign(projectId: string, taskIds: string[], currentUser?: { id: string; userId?: string; role: string }) {
        return this.assignmentService.bulkUnassign(projectId, taskIds, currentUser);
    }

    reassign(id: string, data: { assigneeId: string; performerType: PerformerType; reason: string }, currentUser: { id: string; userId?: string; role?: string }) {
        return this.assignmentService.reassign(id, data, currentUser);
    }

    submitResult(id: string, data: Parameters<TaskResultService["submitResult"]>[1], currentUser?: { id: string, userId?: string; role?: string }) {
        return this.resultService.submitResult(id, data, currentUser);
    }

    submitSavedResultForReview(id: string, currentUser?: { id: string, userId?: string; role?: string }) {
        return this.resultService.submitSavedResultForReview(id, currentUser);
    }

    requestRework(id: string, data: Parameters<TaskResultService["requestRework"]>[1], currentUser?: { id: string, userId?: string; role?: string }) {
        return this.resultService.requestRework(id, data, currentUser);
    }

    approveByCustomer(id: string, currentUser?: { id: string; userId?: string; role: string }) {
        return this.resultService.approveByCustomer(id, currentUser);
    }

    customerDoesNotPurchase(id: string, currentUser?: { id: string; userId?: string; role: string }) {
        return this.resultService.customerDoesNotPurchase(id, currentUser);
    }

    requestSupport(id: string, note: string) {
        return this.supportService.requestSupport(id, note);
    }

    /*
    // Deprecated cross-team support delegation
    assignSupportTeam(id: string, teamId: string) {
        return this.supportService.assignSupportTeam(id, teamId);
    }

    respondToSupport(id: string, action: 'ACCEPT' | 'REJECT', currentUser: { id: string }) {
        return this.supportService.respondToSupport(id, action, currentUser);
    }

    returnSupport(id: string) {
        return this.supportService.returnSupport(id);
    }

    requestReturnSupport(id: string, note: string) {
        return this.supportService.requestReturnSupport(id, note);
    }
    */

    assessExtraTask(id: string, data: { isBillable: boolean, isRejected?: boolean, sellingPrice?: number, serviceId?: string }) {
        return this.pricingService.assessExtraTask(id, data);
    }

    delete(id: string) {
        return this.deletionService.delete(id);
    }

    sendReminder(id: string, currentUser?: { id: string; userId?: string; role?: string }) {
        return this.reminderService.sendReminder(id, currentUser);
    }

    requestStaffing(id: string, note: string | undefined, currentUser: { id: string; userId?: string; role?: string }) {
        return this.delegationService.requestStaffing(id, note, currentUser);
    }

    respondStaffingRequest(
        id: string,
        action: "RESOLVE" | "REJECT",
        currentUser: { id: string; userId?: string; role?: string }
    ) {
        return this.delegationService.respondStaffingRequest(id, action, currentUser);
    }

    createSubtask(
        id: string,
        data: { name: string; assigneeId: string; allocationPercent: number; description?: string },
        currentUser: { id: string; userId?: string; role?: string }
    ) {
        return this.delegationService.createSubtask(id, data, currentUser);
    }

    updateSubtask(
        id: string,
        data: { name: string; assigneeId: string; allocationPercent: number; description?: string },
        currentUser: { id: string; userId?: string; role?: string }
    ) {
        return this.delegationService.updateSubtask(id, data, currentUser);
    }

    submitSubtaskPlan(
        id: string,
        currentUser: { id: string; userId?: string; role?: string }
    ) {
        return this.delegationService.submitSubtaskPlan(id, currentUser);
    }

    respondSubtaskPlan(
        id: string,
        action: "APPROVE" | "REJECT",
        note: string | undefined,
        currentUser: { id: string; userId?: string; role?: string }
    ) {
        return this.delegationService.respondSubtaskPlan(id, action, note, currentUser);
    }
}
