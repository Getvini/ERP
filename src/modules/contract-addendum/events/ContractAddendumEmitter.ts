import { EventEmitter } from "events";

class ContractAddendumEmitter extends EventEmitter {}

export const contractAddendumEmitter = new ContractAddendumEmitter();

export const CONTRACT_ADDENDUM_EVENTS = {
    CREATED: "contract_addendum_created",
    UPDATED: "contract_addendum_updated",
    SIGNED: "contract_addendum_signed",
    REJECTED: "contract_addendum_rejected",
    APPROVED: "contract_addendum_approved",
};
