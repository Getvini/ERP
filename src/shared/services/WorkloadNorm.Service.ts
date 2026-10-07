import { In } from "typeorm";
import { AppDataSource } from "../../data-source";
import { STAFF_ROLES, UserRole } from "../../modules/account/entities/Account.entity";
import { StaffRoleWorkloadNorms } from "../../modules/setting/entities/StaffRoleWorkloadNorm.entity";
import { TaskStatus } from "../entities/Enums";

export type WorkloadNormItem = {
    role: UserRole;
    monthlyNorm: number;
    dailyNorm: number;
    isCustomized: boolean;
    updatedAt: Date | null;
};

type Actor = { id?: string; userId?: string; role?: string };

function httpError(message: string, statusCode: number) {
    const error = new Error(message) as Error & { statusCode?: number };
    error.statusCode = statusCode;
    return error;
}

export class WorkloadNormService {
    // Tiêu chuẩn từ 10/2026: 22.000 Vinicoin/tháng và 800 Vinicoin/ngày.
    // 22.000 / 800 = 27,5 nên số ngày chuẩn/tháng là 27,5 để định mức ngày luôn khớp 800 khi tháng = 22.000.
    static readonly DEFAULT_MONTHLY_NORM = 22000;
    static readonly DAYS_PER_MONTH = 27.5;
    static readonly ACTIVE_WORKLOAD_STATUSES = [
        TaskStatus.PENDING,
        TaskStatus.NOT_STARTED,
        TaskStatus.DOING,
        TaskStatus.OVERDUE,
        TaskStatus.REWORKING,
        TaskStatus.REJECTED,
        TaskStatus.REJECTED_SUPPORT,
        TaskStatus.SUPPORT_PENDING,
        TaskStatus.SUPPORT_AWAITING_RETURN,
        TaskStatus.AWAITING_SUPPORT
    ];

    private repository = AppDataSource.getRepository(StaffRoleWorkloadNorms);

    static isActiveWorkloadStatus(status?: TaskStatus | string | null) {
        return WorkloadNormService.ACTIVE_WORKLOAD_STATUSES.includes(status as TaskStatus);
    }

    static getDailyNorm(monthlyNorm: number) {
        return monthlyNorm / WorkloadNormService.DAYS_PER_MONTH;
    }

    private normalizeMonthlyNorm(value: unknown) {
        const monthlyNorm = Number(value);
        if (!Number.isFinite(monthlyNorm) || monthlyNorm <= 0) {
            throw httpError("Định mức tháng phải là số dương", 400);
        }
        return monthlyNorm;
    }

    private assertStaffRole(role: unknown): asserts role is UserRole {
        if (!STAFF_ROLES.includes(role as UserRole)) {
            throw httpError("Role định mức workload không hợp lệ", 400);
        }
    }

    private buildItem(role: UserRole, row?: StaffRoleWorkloadNorms | null): WorkloadNormItem {
        const monthlyNorm = Number(row?.monthlyNorm || WorkloadNormService.DEFAULT_MONTHLY_NORM);
        return {
            role,
            monthlyNorm,
            dailyNorm: WorkloadNormService.getDailyNorm(monthlyNorm),
            isCustomized: Boolean(row),
            updatedAt: row?.updatedAt || null
        };
    }

    async getNorms(): Promise<WorkloadNormItem[]> {
        const rows = await this.repository.find({
            where: { role: In(STAFF_ROLES) }
        });
        const byRole = new Map(rows.map(row => [row.role, row]));
        return STAFF_ROLES.map(role => this.buildItem(role, byRole.get(role)));
    }

    async getNormMap(roles: UserRole[]) {
        const uniqueRoles = Array.from(new Set(roles.filter(role => STAFF_ROLES.includes(role))));
        const rows = uniqueRoles.length > 0
            ? await this.repository.find({ where: { role: In(uniqueRoles) } })
            : [];
        const byRole = new Map(rows.map(row => [row.role, row]));
        return new Map(uniqueRoles.map(role => [role, this.buildItem(role, byRole.get(role))]));
    }

    async getNormForRole(role?: UserRole | null) {
        if (!role || !STAFF_ROLES.includes(role)) return null;
        const row = await this.repository.findOne({ where: { role } });
        return this.buildItem(role, row);
    }

    async updateNorms(input: { role: UserRole; monthlyNorm: number }[], actor?: Actor) {
        if (!Array.isArray(input) || input.length === 0) {
            throw httpError("Vui lòng cung cấp danh sách định mức workload", 400);
        }

        const normalized = input.map(item => {
            this.assertStaffRole(item?.role);
            return {
                role: item.role,
                monthlyNorm: this.normalizeMonthlyNorm(item.monthlyNorm),
                updatedById: actor?.userId || actor?.id || null
            };
        });

        await this.repository.save(normalized);
        return this.getNorms();
    }
}
