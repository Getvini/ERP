import test from "node:test";
import assert from "node:assert/strict";
import { OpportunityStatus } from "../entities/Opportunity.entity";
import {
    assertRejectedOpportunityEditable,
    canEditRejectedOpportunity,
    stripProtectedOpportunityFields,
    FORBIDDEN_OPPORTUNITY_EDIT
} from "./OpportunityResubmit.helper";

const rejected = { status: OpportunityStatus.OPP_REJECTED, createdBy: { id: "u1" } };

test("người tạo được sửa cơ hội bị từ chối", () => {
    assert.equal(canEditRejectedOpportunity(rejected, { role: "BD", userId: "u1" }), true);
    assert.doesNotThrow(() => assertRejectedOpportunityEditable(rejected, { role: "BD", userId: "u1" }));
});

test("ADMIN được sửa cơ hội bị từ chối", () => {
    assert.equal(canEditRejectedOpportunity(rejected, { role: "ADMIN", userId: "u9" }), true);
});

test("BOD và người khác không được sửa", () => {
    assert.equal(canEditRejectedOpportunity(rejected, { role: "BOD", userId: "u9" }), false);
    assert.equal(canEditRejectedOpportunity(rejected, { role: "BD", userId: "u2" }), false);
    assert.throws(
        () => assertRejectedOpportunityEditable(rejected, { role: "BD", userId: "u2" }),
        new Error(FORBIDDEN_OPPORTUNITY_EDIT)
    );
});

test("không có người thực hiện hoặc không có createdBy thì từ chối", () => {
    assert.equal(canEditRejectedOpportunity(rejected, undefined), false);
    assert.equal(canEditRejectedOpportunity({ status: OpportunityStatus.OPP_REJECTED, createdBy: null }, { role: "BD", userId: "u1" }), false);
});

test("chỉ cho sửa khi trạng thái là OPP_REJECTED", () => {
    for (const status of [OpportunityStatus.PENDING_OPP_APPROVAL, OpportunityStatus.QUOTATION_DRAFTING, OpportunityStatus.OPEN]) {
        assert.throws(
            () => assertRejectedOpportunityEditable({ status, createdBy: { id: "u1" } }, { role: "ADMIN", userId: "u1" }),
            /trạng thái không duyệt/
        );
    }
});

test("loại bỏ các trường được bảo vệ khỏi dữ liệu client gửi lên", () => {
    const result = stripProtectedOpportunityFields({
        name: "A",
        status: OpportunityStatus.QUOTATION_DRAFTING,
        rejectionReason: "x",
        opportunityCode: "OPP-1",
        id: "z",
        createdBy: { id: "hack" },
        budget: 5
    });
    assert.deepEqual(result, { name: "A", budget: 5 });
});
