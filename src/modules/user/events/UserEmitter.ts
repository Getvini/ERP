import { EventEmitter } from "events";

class UserEmitter extends EventEmitter {}

export const userEmitter = new UserEmitter();

export const USER_EVENTS = {
    CREATED: "user_created",
    UPDATED: "user_updated",
    DELETED: "user_deleted",
};
