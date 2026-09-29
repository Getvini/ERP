import { isManagementRole, isStaffRole, UserRole } from "../../modules/account/entities/Account.entity";
import { IsNull, Not } from "typeorm";

type ActorInfo = { id: string, role: string, userId?: string, companyId?: string };

export class SecurityService {
    static getTenantId(userInfo?: any): string | undefined {
        return undefined;
    }

    static getTenantWhere(userInfo?: any): any {
        return {};
    }

    static withTenant(where: any = {}, userInfo?: any): any {
        return where;
    }

    static getTenantCachePart(userInfo?: any): string {
        return "global";
    }

    /**
     * Generates TypeORM 'where' filter for Opportunities based on user role and ID.
     * 
     * @param userInfo - User information (ID and role)
     * @returns One or more where clauses (as an object or array)
     * @throws Error if the user role is not allowed to access the resource
     */
    static getOpportunityFilters(userInfo: ActorInfo): any {
        const { id, role } = userInfo;

        // Full access for internal management roles
        if ([UserRole.BOD, UserRole.ADMIN, UserRole.ADMIN_SALE].includes(role as UserRole)) {
            return SecurityService.getTenantWhere(userInfo);
        }

        // Business Development (BD) can only see:
        // 1. Opportunities created by them
        // 2. Opportunities linked to customers created by them
        if (role === UserRole.BD) {
            return SecurityService.withTenant([
                { createdBy: { accounts: { id: id } } },
                { customer: { createdBy: { accounts: { id: id } } } }
            ], userInfo);
        }

        // Staff and PM have no access to the opportunity list
        if (isStaffRole(role) || role === UserRole.PM) {
            throw new Error("FORBIDDEN_ACCESS");
        }

        // Default: only see their own (restrictive fallback)
        return SecurityService.withTenant({ createdBy: { accounts: { id: id } } }, userInfo);
    }

    /**
     * Generates TypeORM 'where' filter for Customers based on user role and ID.
     */
    static getCustomerFilters(userInfo: ActorInfo): any {
        const { id, role } = userInfo;

        // Full access for internal management roles
        if ([UserRole.BOD, UserRole.ADMIN, UserRole.ADMIN_SALE].includes(role as UserRole)) {
            return SecurityService.getTenantWhere(userInfo);
        }

        // Business Development (BD) can only see customers created by them
        if (role === UserRole.BD) {
            return SecurityService.withTenant({ createdBy: { accounts: { id: id } } }, userInfo);
        }

        // Staff and PM have no access to the customer list
        if (isStaffRole(role) || role === UserRole.PM) {
            throw new Error("FORBIDDEN_ACCESS");
        }

        // Default: only see their own (restrictive fallback)
        return SecurityService.withTenant({ createdBy: { accounts: { id: id } } }, userInfo);
    }

    /**
     * Generates TypeORM 'where' filter for Contracts based on user role and ID.
     */
    static getContractFilters(userInfo: ActorInfo): any {
        const { id, role } = userInfo;

        // Full read access for internal management roles, sales admin, and PM.
        if ([UserRole.BOD, UserRole.ADMIN, UserRole.ADMIN_SALE, UserRole.PM].includes(role as UserRole)) {
            return SecurityService.getTenantWhere(userInfo);
        }

        // Business Development (BD) can only see contracts created by them OR for customers they created
        if (role === UserRole.BD) {
            return SecurityService.withTenant([
                { createdBy: { id: userInfo.userId } }, // Created by the user (using userId relation)
                { customer: { createdBy: { id: userInfo.userId } } }, // Customer created by the user
                { opportunity: { createdBy: { id: userInfo.userId } } } // Opportunity created by the user
            ], userInfo);
        }

        // Staff have no access to the contract list
        if (isStaffRole(role)) {
            throw new Error("FORBIDDEN_ACCESS");
        }

        // Default fallback (restrictive)
        return SecurityService.withTenant({ createdBy: { id: userInfo.userId } }, userInfo);
    }

    /**
     * Generates TypeORM 'where' filter for Projects based on user role and ID.
     */
    static getProjectFilters(userInfo: ActorInfo): any {
        const { id, role } = userInfo;

        // Full access for internal management roles + sales admin (khớp với getPaymentMilestoneFilters/
        // getDebtFilters: Admin Sale cần thấy toàn bộ dự án để lọc/duyệt yêu cầu thanh toán)
        if (isManagementRole(role) || role === UserRole.ADMIN_SALE) {
            return SecurityService.getTenantWhere(userInfo);
        }

        // PM only sees projects where they are explicitly assigned as PROJECT_MANAGER.
        if (role === UserRole.PM) {
            const uid = userInfo.userId || "__UNLINKED_PM__";
            return SecurityService.withTenant([
                { team: { members: { user: { id: uid } } } },   // là thành viên bất kỳ
                { tasks: { helper: { id: uid } } },
                { tasks: { supportLeadId: uid } }
            ], userInfo);
        }

        // Business Development (BD) can see projects related to their contracts, customers, or opportunities
        if (role === UserRole.BD) {
            return SecurityService.withTenant([
                { contract: { createdBy: { id: userInfo.userId } } },
                { contract: { customer: { createdBy: { id: userInfo.userId } } } },
                { contract: { opportunity: { createdBy: { id: userInfo.userId } } } }
            ], userInfo);
        }

        // Staff can see projects where they are:
        // 1. In the assigned project team
        // 2. A helper on any task in the project
        // 3. A support lead on any task in the project
        if (isStaffRole(role)) {
            return SecurityService.withTenant([
                { team: { members: { user: { id: userInfo.userId } } } },
                { tasks: { helper: { id: userInfo.userId } } },
                { tasks: { supportLeadId: userInfo.userId } }
            ], userInfo);
        }

        // Default: restrictive fallback
        return SecurityService.withTenant({ team: { members: { user: { id: userInfo.userId } } } }, userInfo);
    }

    /**
     * Generates TypeORM 'where' filter for Payment Milestones based on user role and ID.
     */
    static getPaymentMilestoneFilters(userInfo: ActorInfo): any {
        const { id, role } = userInfo;

        // Full access for management, sales admin, and accounting
        if ([UserRole.BOD, UserRole.ADMIN, UserRole.ADMIN_SALE].includes(role as UserRole)) {
            return SecurityService.getTenantWhere(userInfo);
        }

        // Business Development (BD) sees milestones for their contracts or customers
        if (role === UserRole.BD) {
            return SecurityService.withTenant([
                { contract: { createdBy: { id: userInfo.userId } } },
                { contract: { customer: { createdBy: { id: userInfo.userId } } } }
            ], userInfo);
        }

        // Staff and PM have no access to payment milestones
        if (isStaffRole(role) || role === UserRole.PM) {
            throw new Error("FORBIDDEN_ACCESS");
        }

        // Default: restrictive fallback
        return SecurityService.withTenant({ contract: { createdBy: { id: userInfo.userId } } }, userInfo);
    }

    /**
     * Generates TypeORM 'where' filter for Debts based on user role and ID.
     */
    static getDebtFilters(userInfo: ActorInfo): any {
        const { id, role } = userInfo;

        // Full access for management, sales admin, and accounting
        if ([UserRole.BOD, UserRole.ADMIN, UserRole.ADMIN_SALE].includes(role as UserRole)) {
            return SecurityService.getTenantWhere(userInfo);
        }

        // Business Development (BD) sees debts for their contracts or customers
        if (role === UserRole.BD) {
            return SecurityService.withTenant([
                { contract: { createdBy: { id: userInfo.userId } } },
                { contract: { customer: { createdBy: { id: userInfo.userId } } } }
            ], userInfo);
        }

        // Staff and PM have no access to debts
        if (isStaffRole(role) || role === UserRole.PM) {
            throw new Error("FORBIDDEN_ACCESS");
        }

        // Default: restrictive fallback
        return SecurityService.withTenant({ contract: { createdBy: { id: userInfo.userId } } }, userInfo);
    }

    /**
     * Generates TypeORM 'where' filter for Tasks based on user role and ID.
     */
    static getTaskFilters(userInfo: ActorInfo): any {
        const { id, role } = userInfo;
        const userId = userInfo.userId;
        const projectOperatorFilters = [
            { project: { team: { teamLead: { id: userId } } } },
            { project: { team: { members: { user: { id: userId }, roles: { role: "ACCOUNT" } } } } },
            { project: { team: { members: { user: { id: userId }, roles: { role: "PROJECT_MANAGER" } } } } }
        ];

        // Full access for management roles
        if (isManagementRole(role)) {
            return SecurityService.getTenantWhere(userInfo);
        }

        // PM sees tasks in projects they manage and the shared queue of
        // opportunity-level Video AI demo tasks that PMs are notified to assign.
        if (role === UserRole.PM) {
            return SecurityService.withTenant([
                {
                    project: {
                        team: {
                            members: {
                                user: { id: userId || "__UNLINKED_PM__" },
                                roles: { role: "PROJECT_MANAGER" }
                            }
                        }
                    }
                },
                {
                    opportunityId: Not(IsNull()),
                    opportunityServiceJob: { isBriefVideo: true }
                }
            ], userInfo);
        }

        // Business Development (BD) can see tasks related to their contracts or customers
        if (role === UserRole.BD) {
            return SecurityService.withTenant([
                { project: { contract: { createdBy: { id: userId } } } },
                { project: { contract: { customer: { createdBy: { id: userId } } } } },
                ...projectOperatorFilters
            ], userInfo);
        }

        // Staff access (including Team Leads and Helpers)
        if (isStaffRole(role)) {
            return SecurityService.withTenant([
                { assignee: { id: userId } },
                { supervisor: { id: userId } },
                { helper: { id: userId } },
                ...projectOperatorFilters,
                { supportLeadId: userId }
            ], userInfo);
        }

        // Default: only see their own assigned tasks
        return SecurityService.withTenant([
            { assignee: { id: userId } },
            ...projectOperatorFilters
        ], userInfo);
    }
}
