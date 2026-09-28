import { EventEmitter } from "events";

class TeamEmitter extends EventEmitter {}

export const teamEmitter = new TeamEmitter();

export const TEAM_EVENTS = {
    CREATED: "team_created",
    UPDATED: "team_updated",
    DELETED: "team_deleted",
    MEMBER_ADDED: "team_member_added",
    MEMBER_UPDATED: "team_member_updated",
    MEMBER_REMOVED: "team_member_removed",
};
