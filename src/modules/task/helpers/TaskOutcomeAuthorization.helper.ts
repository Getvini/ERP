import { MemberRole, memberHasRole } from "../../project/entities/TeamMember.entity";

type UserRef = { id?: string | null } | null | undefined;
type TeamRef = {
    teamLead?: UserRef;
    members?: Array<{
        user?: UserRef;
        roles?: any[];
    }>;
} | null | undefined;

type TaskOutcomeAuthorizationInput = {
    assignerId?: string | null;
    assigner?: UserRef;
    assigneeId?: string | null;
    assignee?: UserRef;
    helperId?: string | null;
    helper?: UserRef;
    supervisor?: UserRef;
    project?: { team?: TeamRef } | null;
};

const idsMatch = (left?: string | null, right?: string | null) =>
    Boolean(left && right && String(left) === String(right));

/**
 * Quyền ghi nhận kết quả sau khi một task dự án đã được nộp:
 * - Giao cho người khác: chỉ người phân công được quyết định.
 * - Tự phân công: một Account khác hoặc PM của chính dự án được quyết định.
 * - Người thực hiện/helper không bao giờ được tự quyết định.
 */
export function canDecideTaskOutcome(task: TaskOutcomeAuthorizationInput, actorUserId?: string | null) {
    if (!actorUserId) return false;

    const assignerId = task.assignerId || task.assigner?.id;
    const performerIds = [
        task.assigneeId || task.assignee?.id,
        task.helperId || task.helper?.id
    ].filter(Boolean) as string[];

    if (performerIds.some(id => idsMatch(id, actorUserId))) return false;

    const isSelfAssigned = Boolean(
        assignerId && performerIds.some(id => idsMatch(id, assignerId))
    );
    if (!isSelfAssigned) return idsMatch(assignerId, actorUserId);

    const team = task.project?.team;

    return team?.members?.some(member =>
        idsMatch(member.user?.id, actorUserId) &&
        (
            memberHasRole(member as any, MemberRole.ACCOUNT) ||
            memberHasRole(member as any, MemberRole.PROJECT_MANAGER)
        )
    ) || false;
}

/**
 * Người nhận thông báo khi kết quả được nộp:
 * - Giao cho người khác: chỉ người phân công.
 * - Tự phân công: các Account khác và PM trong cùng dự án.
 */
export function getTaskSubmissionReviewRecipientIds(
    task: TaskOutcomeAuthorizationInput,
    submitterUserId?: string | null
) {
    const assignerId = task.assignerId || task.assigner?.id;
    const assigneeId = task.assigneeId || task.assignee?.id;
    const helperId = task.helperId || task.helper?.id;
    const excludedIds = [submitterUserId, assigneeId, helperId].filter(Boolean) as string[];
    const isExcluded = (userId?: string | null) =>
        !userId || excludedIds.some(id => idsMatch(id, userId));

    const isSelfAssigned = idsMatch(assignerId, assigneeId);
    if (!isSelfAssigned) {
        return assignerId && !isExcluded(assignerId) ? [assignerId] : [];
    }

    const recipientIds = new Set<string>();
    const addRecipient = (userId?: string | null) => {
        if (userId && !isExcluded(userId)) recipientIds.add(userId);
    };

    const team = task.project?.team;
    for (const member of team?.members || []) {
        if (
            memberHasRole(member as any, MemberRole.ACCOUNT) ||
            memberHasRole(member as any, MemberRole.PROJECT_MANAGER)
        ) {
            addRecipient(member.user?.id);
        }
    }

    return Array.from(recipientIds);
}
