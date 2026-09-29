import { EventEmitter } from "events";
import { Opportunities } from "../entities/Opportunity.entity";

class OpportunityEmitter extends EventEmitter {}

export const opportunityEmitter = new OpportunityEmitter();

export const OPPORTUNITY_EVENTS = {
    CREATED: "opportunity_created",
    UPDATED: "opportunity_updated",
    APPROVED: "opportunity_approved",
    REJECTED: "opportunity_rejected",
    RESUBMITTED: "opportunity_resubmitted",
    DELETED: "opportunity_deleted",
};
