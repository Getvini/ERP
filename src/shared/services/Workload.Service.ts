import { In } from "typeorm";
import { AppDataSource } from "../../data-source";
import { Accounts, STAFF_ROLES, UserRole } from "../../modules/account/entities/Account.entity";
import { Tasks } from "../../modules/task/entities/Task.entity";
import { Users } from "../../modules/user/entities/User.entity";
import { PerformerType } from "../entities/Enums";
import { WorkloadNormService } from "./WorkloadNorm.Service";

export type WorkloadSummary = {
    userId: string;
    kpi: number;
    pendingVinicoin: number;
    rawRatio: number;
    displayRatio: number;
    percent: number;
    displayPercent: number;
    taskCount: number;
};

export type StaffWorkloadSummary = WorkloadSummary & {
    fullName: string;
    role: UserRole;
};

export class WorkloadService {
    static readonly MAX_DISPLAY_RATIO = 2;

    private taskRepository = AppDataSource.getRepository(Tasks);
    private userRepository = AppDataSource.getRepository(Users);
    private workloadNormService = new WorkloadNormService();

    private getMonthRange(month?: number, year?: number) {
        const now = new Date();
        const targetYear = year || now.getFullYear();
        const targetMonth = month || now.getMonth() + 1;
        const start = new Date(targetYear, targetMonth - 1, 1);
        const end = new Date(targetYear, targetMonth, 0, 23, 59, 59, 999);
        return { start, end };
    }

    private buildSummary(userId: string, monthlyNorm: number, pendingVinicoin = 0, taskCount = 0): WorkloadSummary {
        const rawRatio = monthlyNorm > 0 ? pendingVinicoin / monthlyNorm : 0;
        const displayRatio = Math.min(rawRatio, WorkloadService.MAX_DISPLAY_RATIO);

        return {
            userId,
            kpi: monthlyNorm,
            pendingVinicoin,
            rawRatio,
            displayRatio,
            percent: Math.round(rawRatio * 100),
            displayPercent: Math.round(displayRatio * 100),
            taskCount
        };
    }

    private getStaffRole(accounts?: Accounts[]) {
        return accounts?.find(account => STAFF_ROLES.includes(account.role))?.role;
    }

    private async calculateWorkloadsForStaffUsers(
        staffUsers: { user: Users; role: UserRole }[],
        month?: number,
        year?: number
    ): Promise<Map<string, WorkloadSummary>> {
        const workloads = new Map<string, WorkloadSummary>();
        if (staffUsers.length === 0) return workloads;

        const staffUserIds = staffUsers.map(item => item.user.id);
        const normMap = await this.workloadNormService.getNormMap(staffUsers.map(item => item.role));
        const userRoleMap = new Map(staffUsers.map(item => [item.user.id, item.role]));

        staffUsers.forEach(({ user, role }) => {
            const monthlyNorm = normMap.get(role)?.monthlyNorm || WorkloadNormService.DEFAULT_MONTHLY_NORM;
            workloads.set(user.id, this.buildSummary(user.id, monthlyNorm));
        });

        const { start, end } = this.getMonthRange(month, year);
        const rows = await this.taskRepository
            .createQueryBuilder("task")
            .leftJoin("task.job", "job")
            .select("task.assigneeId", "userId")
            .addSelect("COUNT(task.id)", "taskCount")
            .addSelect("COALESCE(SUM(COALESCE(job.vinicoin, 0)), 0)", "pendingVinicoin")
            .where("task.assigneeId IN (:...staffUserIds)", { staffUserIds })
            .andWhere("task.plannedEndDate BETWEEN :start AND :end", { start, end })
            .andWhere("task.performerType = :performerType", { performerType: PerformerType.INTERNAL })
            .andWhere("task.status IN (:...activeStatuses)", {
                activeStatuses: WorkloadNormService.ACTIVE_WORKLOAD_STATUSES
            })
            .groupBy("task.assigneeId")
            .getRawMany();

        rows.forEach(row => {
            const userId = row.userId;
            const role = userRoleMap.get(userId);
            const monthlyNorm = role
                ? normMap.get(role)?.monthlyNorm || WorkloadNormService.DEFAULT_MONTHLY_NORM
                : WorkloadNormService.DEFAULT_MONTHLY_NORM;
            const pendingVinicoin = Number(row.pendingVinicoin || 0);
            const taskCount = Number(row.taskCount || 0);
            workloads.set(userId, this.buildSummary(userId, monthlyNorm, pendingVinicoin, taskCount));
        });

        return workloads;
    }

    async getWorkloadsForUsers(userIds: string[], month?: number, year?: number) {
        const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
        if (uniqueUserIds.length === 0) return new Map<string, WorkloadSummary>();

        const users = await this.userRepository.find({
            where: {
                id: In(uniqueUserIds),
                isLocked: false,
                accounts: { role: In(STAFF_ROLES) }
            },
            relations: ["accounts"]
        });
        const staffUsers = users
            .map(user => ({ user, role: this.getStaffRole(user.accounts) }))
            .filter((item): item is { user: Users; role: UserRole } => Boolean(item.role));

        return this.calculateWorkloadsForStaffUsers(staffUsers, month, year);
    }

    async getWorkloadForUser(userId: string, month?: number, year?: number) {
        const workloads = await this.getWorkloadsForUsers([userId], month, year);
        return workloads.get(userId) || null;
    }

    async getAllStaffWorkloads(month?: number, year?: number): Promise<StaffWorkloadSummary[]> {
        const users = await this.userRepository.find({
            where: {
                isLocked: false,
                accounts: { role: In(STAFF_ROLES) }
            },
            relations: ["accounts"],
            order: { fullName: "ASC" }
        });

        const staffUsers = users
            .map(user => ({ user, role: this.getStaffRole(user.accounts) }))
            .filter((item): item is { user: Users; role: UserRole } => Boolean(item.role));

        const workloads = await this.calculateWorkloadsForStaffUsers(staffUsers, month, year);

        return staffUsers.map(({ user, role }) => ({
            fullName: user.fullName,
            role,
            ...(workloads.get(user.id) || this.buildSummary(
                user.id,
                WorkloadNormService.DEFAULT_MONTHLY_NORM
            ))
        }));
    }
}
