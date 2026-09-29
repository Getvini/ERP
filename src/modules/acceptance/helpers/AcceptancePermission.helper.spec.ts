import assert from "node:assert/strict";
import test from "node:test";
import { UserRole } from "../../account/entities/Account.entity";
import {
  ACCEPTANCE_APPROVER_ROLES,
  isAcceptanceApprover,
} from "./AcceptancePermission.helper";

test("chỉ BOD, ADMIN và ADMIN_SALE được duyệt nghiệm thu", () => {
  assert.deepEqual(ACCEPTANCE_APPROVER_ROLES, [
    UserRole.BOD,
    UserRole.ADMIN,
    UserRole.ADMIN_SALE,
  ]);

  assert.equal(isAcceptanceApprover(UserRole.BOD), true);
  assert.equal(isAcceptanceApprover(UserRole.ADMIN), true);
  assert.equal(isAcceptanceApprover(UserRole.ADMIN_SALE), true);
});

test("PM chỉ được xem nghiệm thu", () => {
  assert.equal(isAcceptanceApprover(UserRole.PM), false);
  assert.equal(isAcceptanceApprover(undefined), false);
});
