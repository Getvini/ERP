import { UserRole } from "../../account/entities/Account.entity";

export const ACCEPTANCE_APPROVER_ROLES: UserRole[] = [
  UserRole.BOD,
  UserRole.ADMIN,
  UserRole.ADMIN_SALE,
];

export const isAcceptanceApprover = (role?: string) =>
  Boolean(role) && ACCEPTANCE_APPROVER_ROLES.includes(role as UserRole);
