import { OpportunityStatus } from "../entities/Opportunity.entity";

export const FORBIDDEN_OPPORTUNITY_EDIT = "FORBIDDEN_ACCESS";

type OpportunityLike = {
    status: OpportunityStatus;
    createdBy?: { id: string } | null;
};

type ActorLike = {
    role: string;
    userId?: string;
};

export const canEditRejectedOpportunity = (opportunity: OpportunityLike, actor?: ActorLike) => {
    if (!actor) return false;
    if (actor.role === "ADMIN") return true;
    return !!actor.userId && !!opportunity.createdBy && opportunity.createdBy.id === actor.userId;
};

export const assertRejectedOpportunityEditable = (opportunity: OpportunityLike, actor?: ActorLike) => {
    if (opportunity.status !== OpportunityStatus.OPP_REJECTED) {
        throw new Error("Chỉ có thể chỉnh sửa và gửi lại cơ hội đang ở trạng thái không duyệt");
    }
    if (!canEditRejectedOpportunity(opportunity, actor)) {
        throw new Error(FORBIDDEN_OPPORTUNITY_EDIT);
    }
};

export const stripProtectedOpportunityFields = (data: Record<string, any> = {}) => {
    const { status, rejectionReason, opportunityCode, id, createdBy, ...rest } = data;
    return rest;
};
