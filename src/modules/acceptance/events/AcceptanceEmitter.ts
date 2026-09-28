import { EventEmitter } from "events";

class AcceptanceEmitter extends EventEmitter {}

export const acceptanceEmitter = new AcceptanceEmitter();

export const ACCEPTANCE_EVENTS = {
    CREATED: "acceptance_created",
    APPROVED: "acceptance_approved",
    REJECTED: "acceptance_rejected",
    PROCESSED: "acceptance_processed",
};
