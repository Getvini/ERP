import test from "node:test";
import assert from "node:assert/strict";
import { MemberRole } from "../../project/entities/TeamMember.entity";
import {
    canDecideTaskOutcome,
    getTaskSubmissionReviewRecipientIds
} from "./TaskOutcomeAuthorization.helper";

const member = (id: string, role: MemberRole) => ({
    user: { id },
    roles: [{ role }]
});

const baseTask = (overrides: Record<string, unknown> = {}) => ({
    assignerId: "account-a",
    assigneeId: "staff-a",
    helperId: null,
    project: {
        team: {
            teamLead: { id: "lead-a" },
            members: [
                member("account-a", MemberRole.ACCOUNT),
                member("account-b", MemberRole.ACCOUNT),
                member("pm-a", MemberRole.PROJECT_MANAGER)
            ]
        }
    },
    ...overrides
});

test("task giao cho người khác chỉ người phân công được quyết định", () => {
    const task = baseTask();
    assert.equal(canDecideTaskOutcome(task, "account-a"), true);
    assert.equal(canDecideTaskOutcome(task, "account-b"), false);
    assert.equal(canDecideTaskOutcome(task, "pm-a"), false);
});

test("người thực hiện và helper không được tự quyết định", () => {
    const task = baseTask({ helperId: "helper-a" });
    assert.equal(canDecideTaskOutcome(task, "staff-a"), false);
    assert.equal(canDecideTaskOutcome(task, "helper-a"), false);
});

test("khi Account tự phân công, Account khác và PM cùng dự án được quyết định", () => {
    const task = baseTask({ assignerId: "account-a", assigneeId: "account-a" });
    assert.equal(canDecideTaskOutcome(task, "account-a"), false);
    assert.equal(canDecideTaskOutcome(task, "account-b"), true);
    assert.equal(canDecideTaskOutcome(task, "pm-a"), true);
    assert.equal(canDecideTaskOutcome(task, "lead-a"), false);
    assert.equal(canDecideTaskOutcome(task, "outsider"), false);
});

test("Account/helper tự phân công vẫn không được tự quyết định", () => {
    const task = baseTask({ assignerId: "account-a", assigneeId: "staff-a", helperId: "account-a" });
    assert.equal(canDecideTaskOutcome(task, "account-a"), false);
    assert.equal(canDecideTaskOutcome(task, "account-b"), true);
});

test("task cũ thiếu người phân công không cấp quyền ngầm", () => {
    assert.equal(canDecideTaskOutcome(baseTask({ assignerId: null }), "account-a"), false);
});

test("giao cho người khác chỉ thông báo Account đã phân công", () => {
    assert.deepEqual(
        getTaskSubmissionReviewRecipientIds(baseTask(), "staff-a"),
        ["account-a"]
    );
});

test("tự phân công thông báo Account khác và PM cùng dự án", () => {
    const task = baseTask({ assignerId: "account-a", assigneeId: "account-a" });
    assert.deepEqual(
        getTaskSubmissionReviewRecipientIds(task, "account-a").sort(),
        ["account-b", "pm-a"]
    );
});

test("Team Lead không nhận thông báo và không được quyết định khi tự phân công", () => {
    const task = baseTask({ assignerId: "account-a", assigneeId: "account-a" });
    assert.equal(getTaskSubmissionReviewRecipientIds(task, "account-a").includes("lead-a"), false);
    assert.equal(canDecideTaskOutcome(task, "lead-a"), false);
});

test("không thông báo người thực hiện hoặc helper", () => {
    const task = baseTask({
        assignerId: "account-a",
        assigneeId: "account-a",
        helperId: "account-b"
    });
    assert.deepEqual(
        getTaskSubmissionReviewRecipientIds(task, "account-a"),
        ["pm-a"]
    );
});