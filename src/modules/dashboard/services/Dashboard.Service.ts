import { AppDataSource } from "../../../data-source";
import { Contracts, ContractStatus } from "../../contract/entities/Contract.entity";
import { Customers } from "../../customer/entities/Customer.entity";
import { Debts, DebtStatus } from "../../debt/entities/Debt.entity";
import { DebtPayments } from "../../debt/entities/DebtPayment.entity";
import { Projects, ProjectStatus } from "../../project/entities/Project.entity";
import { ContractServices, ContractServiceStatus } from "../../contract/entities/ContractService.entity";
import { Quotations, QuotationStatus } from "../../quotation/entities/Quotation.entity";
import { Tasks } from "../../task/entities/Task.entity";
import { TaskStatus } from "../../../shared/entities/Enums";
import { Opportunities, OpportunityStatus } from "../../opportunity/entities/Opportunity.entity";
import { UserRole } from "../../account/entities/Account.entity";
import { Between, In } from "typeorm";
import { Violations } from "../../task/entities/Violation.entity";
import { DashboardScopeType, selectDashboardWorkItems } from "./Dashboard.Scope";
import { DashboardActor, DashboardScopeService } from "./DashboardScope.Service";
import { WorkloadService } from "../../../shared/services/Workload.Service";
import { getMemberRoles } from "../../project/entities/TeamMember.entity";

export class DashboardService {
    private contractRepo = AppDataSource.getRepository(Contracts);
    private customerRepo = AppDataSource.getRepository(Customers);
    private debtRepo = AppDataSource.getRepository(Debts);
    private projectRepo = AppDataSource.getRepository(Projects);
    private taskRepo = AppDataSource.getRepository(Tasks);
    private opportunityRepo = AppDataSource.getRepository(Opportunities);
    private quotationRepo = AppDataSource.getRepository(Quotations);
    private scopeService = new DashboardScopeService();
    private workloadService = new WorkloadService();

    async getDashboardData(
        actor: DashboardActor,
        requestedUserId?: string,
        month?: number,
        year?: number,
        projectId?: string,
        mode?: "personal" | "management"
    ) {
        const data: any = {};
        const dateFilter = this.getDateFilter(month, year);
        const scope = await this.scopeService.resolve(actor, requestedUserId, projectId, mode);

        const userId = scope.targetUserId;
        const role = actor.role;

        data.scope = {
            type: scope.type,
            targetUserId: scope.targetUserId,
            selectedProjectId: scope.selectedProjectId,
            canSelectMembers: scope.canSelectMembers,
            availableProjects: scope.availableProjects,
            availableMembers: scope.availableMembers,
            isAccountViewer: Boolean(scope.isAccountViewer),
            isAccountViewingMember: Boolean(scope.isAccountViewingMember),
            mode: scope.mode
        };

        const [staffWorkloads, adminMetrics] = await Promise.all([
            scope.canSelectMembers
                ? this.workloadService.getAllStaffWorkloads(month, year)
                : Promise.resolve(undefined),
            scope.type === DashboardScopeType.SYSTEM
                ? this.getAdminMetrics(dateFilter, projectId, month, year)
                : Promise.resolve(undefined)
        ]);

        if (staffWorkloads) {
            data.staffWorkloads = staffWorkloads;
        }

        // 1. BOD/ADMIN Data
        if (scope.type === DashboardScopeType.SYSTEM) {
            data.admin = adminMetrics;
            data.admin.staffWorkloads = staffWorkloads
                ?? await this.workloadService.getAllStaffWorkloads(month, year);
        }

        // 2. Team Lead Data
        const ledProjectIds = scope.type === DashboardScopeType.MANAGEMENT
            ? (projectId ? [projectId] : scope.projectIds)
            : [];
        const ledProjects = ledProjectIds.length > 0
            ? await this.projectRepo.find({
                where: { id: In(ledProjectIds) },
                relations: ["contract"]
            })
            : [];

        if (ledProjects.length > 0) {
            const ledContractIds = ledProjects.map(p => p.contract?.id).filter(Boolean) as string[];
            const ledStatsMap = new Map<string, { totalServices: number; completedServices: number }>();
            if (ledContractIds.length > 0) {
                const rawStats = await AppDataSource.getRepository(ContractServices)
                    .createQueryBuilder("cs")
                    .innerJoin("cs.contract", "contract")
                    .select("contract.id", "contractId")
                    .addSelect("COUNT(cs.id)", "totalServices")
                    .addSelect(`COUNT(CASE WHEN cs.status = :compStatus THEN 1 END)`, "completedServices")
                    .where("contract.id IN (:...contractIds)", { contractIds: Array.from(new Set(ledContractIds)) })
                    .setParameter("compStatus", ContractServiceStatus.COMPLETED)
                    .groupBy("contract.id")
                    .getRawMany();

                for (const s of rawStats) {
                    ledStatsMap.set(s.contractId, {
                        totalServices: parseInt(s.totalServices, 10) || 0,
                        completedServices: parseInt(s.completedServices, 10) || 0,
                    });
                }
            }

            data.teamLead = ledProjects.map(p => {
                const stats = p.contract?.id ? ledStatsMap.get(p.contract.id) : undefined;
                const totalServices = stats?.totalServices || 0;
                const completedServices = stats?.completedServices || 0;
                return {
                    id: p.id,
                    name: p.name,
                    status: p.status,
                    serviceCount: totalServices,
                    completedServiceCount: completedServices,
                    progress: totalServices > 0 ? Math.round((completedServices / totalServices) * 100) : 0,
                    role: "ACCOUNT"
                };
            });
        }

        // 3. Sale Data
        if (role === UserRole.BD) {
            const [myOpportunities, myCustomers, myContracts] = await Promise.all([
                this.opportunityRepo.find({
                    where: {
                        createdBy: { id: userId },
                        ...(dateFilter && { createdAt: dateFilter })
                    }
                }),
                this.customerRepo.count({
                    where: {
                        createdBy: { id: userId },
                        ...(dateFilter && { createdAt: dateFilter })
                    }
                }),
                this.contractRepo.find({
                    where: [
                        { customer: { createdBy: { id: userId } }, ...(dateFilter && { createdAt: dateFilter }) },
                        { opportunity: { createdBy: { id: userId } }, ...(dateFilter && { createdAt: dateFilter }) }
                    ],
                    relations: ["debts", "debts.payments", "project", "customer"]
                })
            ]);

            const statusCounts = myOpportunities.reduce((acc: any, opp) => {
                acc[opp.status] = (acc[opp.status] || 0) + 1;
                return acc;
            }, {});

            let totalDebt = 0;
            const upcomingDebts: any[] = [];
            const saleProjects: any[] = [];
            const processedProjectIds = new Set();

            myContracts.forEach(contract => {
                contract.debts?.forEach(debt => {
                    const paidAmount = debt.payments?.reduce((sum, p) => sum + parseFloat(p.amount as any), 0) || 0;
                    const remaining = parseFloat(debt.amount as any) - paidAmount;
                    if (remaining > 0 && debt.status !== DebtStatus.PAID) {
                        totalDebt += remaining;
                        upcomingDebts.push({
                            id: debt.id,
                            name: debt.name,
                            amount: debt.amount,
                            remaining: remaining,
                            dueDate: debt.dueDate,
                            customerName: contract.customer?.name,
                            contractCode: contract.contractCode
                        });
                    }
                });

                if (contract.project && !processedProjectIds.has(contract.project.id)) {
                    processedProjectIds.add(contract.project.id);
                    saleProjects.push({
                        id: contract.project.id,
                        name: contract.project.name,
                        status: contract.project.status,
                        customerName: contract.customer?.name,
                        role: "BD"
                    });
                }
            });

            const sortedDebts = upcomingDebts
                .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())
                .slice(0, 5);

            data.sale = {
                totalOpportunities: myOpportunities.length,
                totalExpectedRevenue: myOpportunities.reduce((sum, opp) => sum + parseFloat(opp.expectedRevenue as any), 0),
                statusCounts,
                totalCustomers: myCustomers,
                totalDebt,
                upcomingDebts: sortedDebts,
                projects: saleProjects
            };
        }

        // 4. Personal Tasks (strictly assigned to or helped by user)
        const personalProjectFilter = projectId
            ? { id: projectId }
            : (scope.projectIds?.length > 0 ? In(scope.projectIds) : undefined);

        const personalTaskWhere = [
            { assignee: { id: userId }, ...(personalProjectFilter && { project: personalProjectFilter }) },
            { helper: { id: userId }, ...(personalProjectFilter && { project: personalProjectFilter }) }
        ].flatMap(condition => this.withTaskPeriod(condition, dateFilter));

        const rawPersonalTasks = await this.taskRepo.find({
            where: personalTaskWhere,
            relations: ["project", "project.contract", "project.contract.customer", "project.contract.services", "assignee", "helper"],
            select: {
                id: true,
                name: true,
                nickname: true,
                status: true,
                code: true,
                plannedStartDate: true,
                plannedEndDate: true,
                assignee: { 
                    id: true,
                    fullName: true
                },
                helper: { id: true },
                project: {
                    id: true,
                    name: true,
                    status: true,
                    contract: {
                        id: true,
                        customer: {
                            id: true,
                            name: true
                        },
                        services: {
                            id: true,
                            status: true
                        }
                    }
                }
            },
            order: { plannedEndDate: "DESC" }
        });

        const activeTasks = rawPersonalTasks.filter(t => !t.project || (t.project.status !== ProjectStatus.COMPLETED && t.project.status !== ProjectStatus.CANCELLED));

        // 5. Role-based Tasks (for MetricCardsGrid / roleStats)
        let activeRoleTasks: Tasks[];

        if (scope.type === DashboardScopeType.PERSONAL) {
            // Khi xem Dashboard cá nhân, role tasks trùng khớp với personal tasks -> Tái sử dụng, không query lại DB
            activeRoleTasks = activeTasks;
        } else {
            const roleTaskBaseConditions: any[] = [];
            if (scope.type === DashboardScopeType.SYSTEM) {
                roleTaskBaseConditions.push({ ...(projectId && { project: { id: projectId } }) });
            } else if (scope.type === DashboardScopeType.MANAGEMENT) {
                const targetProjectFilter = projectId
                    ? { id: projectId }
                    : (scope.projectIds?.length > 0 ? { id: In(scope.projectIds) } : undefined);
                if (targetProjectFilter) {
                    roleTaskBaseConditions.push({ project: targetProjectFilter });
                }
            }

            const taskWhereConditions = roleTaskBaseConditions.flatMap(condition =>
                this.withTaskPeriod(condition, dateFilter)
            );

            // Bỏ quan hệ 1-N "project.contract.services" để triệt tiêu Cartesian Product (Tích Đề-các)
            const rawRoleTasks = taskWhereConditions.length > 0
                ? await this.taskRepo.find({
                    where: taskWhereConditions,
                    relations: ["project", "project.contract", "project.contract.customer", "assignee", "helper"],
                    select: {
                        id: true,
                        name: true,
                        nickname: true,
                        status: true,
                        code: true,
                        plannedStartDate: true,
                        plannedEndDate: true,
                        assignee: { id: true, fullName: true },
                        helper: { id: true },
                        project: {
                            id: true,
                            name: true,
                            status: true,
                            contract: {
                                id: true,
                                customer: {
                                    id: true,
                                    name: true
                                }
                            }
                        }
                    },
                    order: { plannedEndDate: "DESC" }
                })
                : [];

            activeRoleTasks = rawRoleTasks.filter(t => !t.project || (t.project.status !== ProjectStatus.COMPLETED && t.project.status !== ProjectStatus.CANCELLED));
        }
        const workTasks = selectDashboardWorkItems(
            scope.type,
            activeTasks,
            activeRoleTasks
        );

        // Role-based stats calculation
        const roleStatusCounts = activeRoleTasks.reduce((acc: any, t) => {
            acc[t.status] = (acc[t.status] || 0) + 1;
            return acc;
        }, {});

        const roleOverdueCount = activeRoleTasks.filter(t => t.status === TaskStatus.OVERDUE).length;

        const roleReworkCount = activeRoleTasks.filter(t =>
            [TaskStatus.REWORKING, TaskStatus.REJECTED].includes(t.status as any)
        ).length;

        const roleStats = {
            // doingCount: (roleStatusCounts[TaskStatus.DOING] || 0) + (roleStatusCounts[TaskStatus.REWORKING] || 0) + (roleStatusCounts[TaskStatus.REJECTED] || 0),
            doingCount: (roleStatusCounts[TaskStatus.DOING] || 0),
            // completedCount: (roleStatusCounts[TaskStatus.COMPLETED] || 0) + (roleStatusCounts[TaskStatus.ACCEPTED] || 0) + (roleStatusCounts[TaskStatus.INTERNAL_COMPLETED] || 0),
            completedCount: (roleStatusCounts[TaskStatus.COMPLETED] || 0),
            overdueCount: roleOverdueCount,
            reworkCount: roleReworkCount,
            pendingCount: (roleStatusCounts[TaskStatus.AWAITING_REVIEW] || 0) + (roleStatusCounts.WAITING_APPROVAL || 0),
            totalTasks: activeRoleTasks.length
        };

        const userWithAccount = await AppDataSource.getRepository("Users").findOne({
            where: { id: userId },
            relations: ["accounts"]
        }) as any;
        const account = userWithAccount?.accounts?.[0];

        const vinicoin = account?.vinicoin || 0;
        const vinicoinTotal = account?.vinicoinTotal || 0;
        const vinicoinWithdrawn = account?.vinicoinWithdrawn || 0;

        const violations = await AppDataSource.getRepository(Violations).find({
            where: {
                userId,
                ...(dateFilter && { createdAt: dateFilter })
            },
            select: { id: true, type: true, createdAt: true }
        });

        const violationStats = violations.reduce((acc: any, v) => {
            acc[v.type] = (acc[v.type] || 0) + 1;
            return acc;
        }, {});

        // Participating Projects
        const canReuseActiveProjects = Boolean(
            scope.activeProjects && (
                scope.type === DashboardScopeType.SYSTEM ||
                scope.type === DashboardScopeType.MANAGEMENT
            )
        );
        const teamProjects = canReuseActiveProjects
            ? scope.activeProjects!
            : (scope.projectIds.length > 0 ? await this.projectRepo.find({
                where: {
                    id: In(scope.projectIds),
                    status: In([ProjectStatus.PENDING_CONFIRMATION, ProjectStatus.CONFIRMED, ProjectStatus.IN_PROGRESS])
                },
                relations: ["contract", "contract.customer", "team", "team.teamLead", "team.members", "team.members.user"]
            }) : []);

        // Batch aggregate service counts for all relevant contracts to avoid Cartesian product explosion
        const contractIdsToQuery = new Set<string>();
        teamProjects.forEach(p => {
            if (p.contract?.id) contractIdsToQuery.add(p.contract.id);
        });
        activeTasks.forEach(t => {
            if (t.project?.contract?.id) contractIdsToQuery.add(t.project.contract.id);
        });

        const serviceStatsMap = new Map<string, { totalServices: number; completedServices: number }>();
        if (contractIdsToQuery.size > 0) {
            const rawStats = await AppDataSource.getRepository(ContractServices)
                .createQueryBuilder("cs")
                .innerJoin("cs.contract", "contract")
                .select("contract.id", "contractId")
                .addSelect("COUNT(cs.id)", "totalServices")
                .addSelect(`COUNT(CASE WHEN cs.status = :compStatus THEN 1 END)`, "completedServices")
                .where("contract.id IN (:...contractIds)", { contractIds: Array.from(contractIdsToQuery) })
                .setParameter("compStatus", ContractServiceStatus.COMPLETED)
                .groupBy("contract.id")
                .getRawMany();

            for (const s of rawStats) {
                serviceStatsMap.set(s.contractId, {
                    totalServices: parseInt(s.totalServices, 10) || 0,
                    completedServices: parseInt(s.completedServices, 10) || 0,
                });
            }
        }

        const projectMap = new Map();

        const addProjectToMap = (project: any) => {
            if (project && !projectMap.has(project.id)) {
                const stats = project.contract?.id ? serviceStatsMap.get(project.contract.id) : undefined;
                const totalServices = stats?.totalServices || 0;
                const completedServices = stats?.completedServices || 0;

                let userRole: string | null = null;
                if (project.team) {
                    if (project.team.teamLead?.id === userId) {
                        userRole = "ACCOUNT";
                    } else if (project.team.members?.length) {
                        const m = project.team.members.find((mem: any) => mem.user?.id === userId);
                        if (m) userRole = getMemberRoles(m)[0];
                    }
                }

                projectMap.set(project.id, {
                    id: project.id,
                    name: project.name,
                    status: project.status,
                    clientName: project.contract?.customer?.name,
                    serviceCount: totalServices,
                    completedServiceCount: completedServices,
                    progress: totalServices > 0 ? Math.round((completedServices / totalServices) * 100) : 0,
                    role: userRole
                });
            }
        };

        teamProjects.forEach(p => addProjectToMap(p));
        activeTasks.forEach(t => addProjectToMap(t.project));

        const participatingProjects = Array.from(projectMap.values()).filter(p =>
            [ProjectStatus.PENDING_CONFIRMATION, ProjectStatus.CONFIRMED, ProjectStatus.IN_PROGRESS].includes(p.status)
        );

        if (data.admin) {
            data.admin.currentProjects = teamProjects.map(project => {
                const stats = project.contract?.id ? serviceStatsMap.get(project.contract.id) : undefined;
                const serviceCount = stats?.totalServices || 0;
                const completedServiceCount = stats?.completedServices || 0;
                return {
                    id: project.id,
                    name: project.name,
                    status: project.status,
                    customerName: project.contract?.customer?.name,
                    teamName: project.team?.name,
                    teamLeadName: project.team?.teamLead?.fullName,
                    plannedStartDate: project.plannedStartDate,
                    plannedEndDate: project.plannedEndDate,
                    serviceCount,
                    completedServiceCount,
                    progress: serviceCount > 0 ? Math.round((completedServiceCount / serviceCount) * 100) : 0
                };
            });
        }

        // Chart Stats (Still using yearly context if year provided, otherwise current year)
        const chartYear = year || new Date().getFullYear();
        const completionStats = Array(12).fill(0);
        const chartDateFilter = Between(
            new Date(chartYear, 0, 1),
            new Date(chartYear, 11, 31, 23, 59, 59, 999)
        );
        const chartWhere = scope.type === DashboardScopeType.SYSTEM
            ? [{ actualEndDate: chartDateFilter, ...(projectId && { project: { id: projectId } }) }]
            : scope.type === DashboardScopeType.MANAGEMENT
                ? [{
                    actualEndDate: chartDateFilter,
                    project: { id: projectId || In(scope.projectIds) }
                }]
                : [
                    { assignee: { id: userId }, actualEndDate: chartDateFilter, ...(projectId && { project: { id: projectId } }) },
                    { helper: { id: userId }, actualEndDate: chartDateFilter, ...(projectId && { project: { id: projectId } }) }
                ];

        // We query all tasks for the chart year to show the trend
        const allTasksForChart = await this.taskRepo.find({
            where: chartWhere,
            select: { status: true, actualEndDate: true }
        });

        allTasksForChart.forEach(t => {
            if (t.status === TaskStatus.ACCEPTED && t.actualEndDate) {
                const date = new Date(t.actualEndDate);
                if (date.getFullYear() === chartYear) {
                    completionStats[date.getMonth()]++;
                }
            }
        });

        const statusCounts = workTasks.reduce((acc: any, t) => {
            acc[t.status] = (acc[t.status] || 0) + 1;
            return acc;
        }, {});

        // Dashboard cá nhân chỉ tính task chính chủ; dashboard quản lý tính toàn bộ dự án trong scope.
        const overdueTasks = workTasks
            .filter(t => t.status === TaskStatus.OVERDUE && (
                scope.type !== DashboardScopeType.PERSONAL || t.assignee?.id === userId
            ))
            .map(t => ({
                id: t.id,
                name: t.name,
                nickname: t.nickname,
                deadline: t.plannedEndDate,
                status: t.status,
                projectName: t.project?.name,
                clientName: t.project?.contract?.customer?.name,
                code: t.code,
                projectId: t.project?.id,
                assignee: t.assignee ? {
                    id: t.assignee.id,
                    fullName: t.assignee.fullName
                } : undefined
            }));

        // 2. Rework Tasks (Làm sai / Bị từ chối do chưa đạt yêu cầu)
        const reworkTasks = workTasks
            .filter(t => [TaskStatus.REWORKING, TaskStatus.REJECTED, TaskStatus.REJECTED_BILLABLE, TaskStatus.REJECTED_SUPPORT].includes(t.status as any))
            .map(t => ({
                id: t.id,
                name: t.name,
                nickname: t.nickname,
                projectName: t.project?.name,
                clientName: t.project?.contract?.customer?.name,
                code: t.code,
                deadline: t.plannedEndDate,
                status: t.status,
                projectId: t.project?.id,
                assignee: t.assignee ? {
                    id: t.assignee.id,
                    fullName: t.assignee.fullName
                } : undefined
            }));

        const memberWorkload = staffWorkloads?.find(w => w.userId === userId)
            ?? await this.workloadService.getWorkloadForUser(userId, month, year);

        data.member = {
            vinicoin,
            vinicoinTotal,
            vinicoinWithdrawn,
            workload: memberWorkload,
            totalTasks: workTasks.length,
            statusCounts,
            doingCount: (statusCounts[TaskStatus.DOING] || 0) + (statusCounts[TaskStatus.REWORKING] || 0) + (statusCounts[TaskStatus.REJECTED] || 0),
            reworkCount: reworkTasks.length,
            reworkTasks,
            overdueCount: overdueTasks.length,
            overdueTasks,
            completedCount: (statusCounts[TaskStatus.COMPLETED] || 0) + (statusCounts[TaskStatus.ACCEPTED] || 0) + (statusCounts[TaskStatus.INTERNAL_COMPLETED] || 0),
            participatingProjects,
            roleStats,
            upcomingDeadlines: activeTasks
                .filter(t => t.status !== TaskStatus.COMPLETED && t.status !== TaskStatus.INTERNAL_COMPLETED && t.status !== TaskStatus.ACCEPTED && t.plannedEndDate)
                .sort((a, b) => new Date(a.plannedEndDate).getTime() - new Date(b.plannedEndDate).getTime())
                .slice(0, 10)
                .map(t => ({
                    id: t.id,
                    name: t.name,
                    nickname: t.nickname,
                    deadline: t.plannedEndDate,
                    status: t.status,
                    projectName: t.project?.name,
                    code: t.code,
                    projectId: t.project?.id
                })),
            calendarTasks: workTasks
                .filter(t => t.plannedStartDate || t.plannedEndDate)
                .map(t => ({
                    id: t.id,
                    name: t.name,
                    nickname: t.nickname,
                    start: t.plannedStartDate,
                    end: t.plannedEndDate,
                    status: t.status,
                    code: t.code,
                    project: t.project,
                    projectId: t.project?.id
                })),
            completionStats: completionStats.map((count, index) => ({
                month: index + 1,
                count
            })),
            violationCount: violations.length,
            violationStats
        };

        if (scope.isAccountViewingMember) {
            data.member.vinicoin = 0;
            data.member.vinicoinTotal = 0;
            data.member.vinicoinWithdrawn = 0;
            data.member.reworkTasks = [];
            data.member.reworkCount = 0;
            data.member.violationCount = 0;
            data.member.violationStats = {};
        }

        return data;
    }

    private getDateRange(month?: number, year?: number): { start: Date; end: Date } | null {
        if (!year && !month) return null;

        let start: Date;
        let end: Date;

        if (year && month) {
            start = new Date(year, month - 1, 1);
            end = new Date(year, month, 0, 23, 59, 59, 999);
        } else if (year) {
            start = new Date(year, 0, 1);
            end = new Date(year, 11, 31, 23, 59, 59, 999);
        } else {
            // Only month provided (unlikely from UI but for safety)
            const currentYear = new Date().getFullYear();
            start = new Date(currentYear, month! - 1, 1);
            end = new Date(currentYear, month!, 0, 23, 59, 59, 999);
        }

        return { start, end };
    }

    private getDateFilter(month?: number, year?: number) {
        const range = this.getDateRange(month, year);
        return range ? Between(range.start, range.end) : null;
    }

    private withTaskPeriod(condition: any, dateFilter: any | null) {
        if (!dateFilter) return [condition];
        return [
            { ...condition, plannedEndDate: dateFilter },
            { ...condition, actualEndDate: dateFilter }
        ];
    }

    private async getAdminMetrics(
        dateFilter: any | null,
        projectId?: string,
        month?: number,
        year?: number
    ) {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const dateRange = this.getDateRange(month, year);

        // Build single combined query for scalar metrics (totalCustomers, newCustomers, totalRevenue, totalDebt)
        const params: any[] = [];
        let pIdx = 1;

        let custWhere = "1=1";
        if (projectId) {
            custWhere += ` AND cust.id IN (SELECT c."customerId" FROM contracts c JOIN projects p ON p."contractId" = c.id WHERE p.id = $${pIdx++})`;
            params.push(projectId);
        }
        let custDateFilter = "";
        if (dateRange) {
            custDateFilter = ` AND cust."createdAt" BETWEEN $${pIdx++} AND $${pIdx++}`;
            params.push(dateRange.start, dateRange.end);
        }

        let newCustWhere = `cust."createdAt" >= $${pIdx++}`;
        params.push(thirtyDaysAgo);
        if (projectId) {
            newCustWhere += ` AND cust.id IN (SELECT c."customerId" FROM contracts c JOIN projects p ON p."contractId" = c.id WHERE p.id = $${pIdx++})`;
            params.push(projectId);
        }

        let revWhere = `c.status IN ('SIGNED', 'COMPLETED')`;
        if (projectId) {
            revWhere += ` AND c.id IN (SELECT p."contractId" FROM projects p WHERE p.id = $${pIdx++})`;
            params.push(projectId);
        }
        if (dateRange) {
            revWhere += ` AND c."createdAt" BETWEEN $${pIdx++} AND $${pIdx++}`;
            params.push(dateRange.start, dateRange.end);
        }

        let debtWhere = `d.status IN ('UNPAID', 'PARTIAL')`;
        if (projectId) {
            debtWhere += ` AND d."contractId" IN (SELECT p."contractId" FROM projects p WHERE p.id = $${pIdx++})`;
            params.push(projectId);
        }

        const scalarSql = `
            SELECT
                (SELECT COUNT(DISTINCT cust.id) FROM customers cust WHERE ${custWhere}${custDateFilter}) AS "totalCustomers",
                (SELECT COUNT(DISTINCT cust.id) FROM customers cust WHERE ${newCustWhere}) AS "newCustomers",
                (SELECT COALESCE(SUM(c."sellingPrice"), 0) FROM contracts c WHERE ${revWhere}) AS "totalRevenue",
                (SELECT COALESCE(SUM(GREATEST(0, d.amount - COALESCE(
                    (SELECT SUM(dp.amount) FROM debt_payments dp WHERE dp."debtId" = d.id), 0
                ))), 0) FROM debts d WHERE ${debtWhere}) AS "totalDebt"
        `;

        const quotationWhere: any[] = [
            {
                status: QuotationStatus.PENDING_APPROVAL,
                ...(projectId && { opportunity: { contracts: { project: { id: projectId } } } })
            },
            {
                status: QuotationStatus.DRAFT,
                opportunity: {
                    status: OpportunityStatus.PENDING_QUOTE_APPROVAL,
                    ...(projectId && { contracts: { project: { id: projectId } } })
                }
            }
        ];
        const contractWhere: any = {
            status: ContractStatus.PROPOSAL_UPLOADED,
            ...(projectId && { project: { id: projectId } })
        };

        // Run all metrics queries in parallel: 1 scalar batch + quotations + contracts (only 3 queries)
        const [
            metricsRow,
            pendingQuotations,
            pendingContracts
        ] = await Promise.all([
            this.debtRepo.manager.query(scalarSql, params).then(rows => rows?.[0]),
            (() => {
                const qb = this.quotationRepo.createQueryBuilder("q")
                    .leftJoin("q.opportunity", "opp")
                    .leftJoin("opp.customer", "cust")
                    .leftJoin("opp.createdBy", "oppCreator")
                    .leftJoin("q.createdBy", "creator")
                    .select([
                        "q.id AS id",
                        "q.version AS version",
                        "q.status AS status",
                        "q.totalAmount AS \"totalAmount\"",
                        "q.createdAt AS \"createdAt\"",
                        "opp.id AS \"opportunityId\"",
                        "opp.opportunityCode AS \"opportunityCode\"",
                        "opp.name AS \"opportunityName\"",
                        "COALESCE(cust.name, opp.leadName) AS \"customerName\"",
                        "COALESCE(creator.fullName, oppCreator.fullName) AS \"createdByName\""
                    ])
                    .where("(q.status = :pendingApproval OR (q.status = :draftStatus AND opp.status = :quoteApprovalStatus))", {
                        pendingApproval: QuotationStatus.PENDING_APPROVAL,
                        draftStatus: QuotationStatus.DRAFT,
                        quoteApprovalStatus: OpportunityStatus.PENDING_QUOTE_APPROVAL
                    });
                if (projectId) {
                    qb.innerJoin("opp.contracts", "contract")
                      .innerJoin("contract.project", "project")
                      .andWhere("project.id = :projectId", { projectId });
                }
                return qb.orderBy("q.createdAt", "DESC").limit(20).getRawMany<{
                    id: string;
                    version: number;
                    status: QuotationStatus;
                    totalAmount: string;
                    createdAt: Date;
                    opportunityId?: string;
                    opportunityCode?: string;
                    opportunityName?: string;
                    customerName?: string;
                    createdByName?: string;
                }>();
            })(),
            (() => {
                const qb = this.contractRepo.createQueryBuilder("c")
                    .leftJoin("c.customer", "cust")
                    .leftJoin("c.opportunity", "opp")
                    .leftJoin("c.createdBy", "creator")
                    .select([
                        "c.id AS id",
                        "c.name AS title",
                        "c.status AS status",
                        "c.sellingPrice AS \"totalAmount\"",
                        "c.createdAt AS \"createdAt\"",
                        "c.contractCode AS \"contractCode\"",
                        "c.proposal_contract AS \"proposalUrl\"",
                        "c.quotation_link AS \"quotationLink\"",
                        "opp.id AS \"opportunityId\"",
                        "opp.name AS \"opportunityName\"",
                        "cust.name AS \"customerName\"",
                        "creator.fullName AS \"createdByName\""
                    ])
                    .where("c.status = :contractStatus", { contractStatus: ContractStatus.PROPOSAL_UPLOADED });
                if (projectId) {
                    qb.innerJoin("c.project", "project")
                      .andWhere("project.id = :projectId", { projectId });
                }
                return qb.orderBy("c.createdAt", "DESC").limit(20).getRawMany<{
                    id: string;
                    title: string;
                    status: ContractStatus;
                    totalAmount: string;
                    createdAt: Date;
                    contractCode: string;
                    proposalUrl?: string;
                    quotationLink?: string;
                    opportunityId?: string;
                    opportunityName?: string;
                    customerName?: string;
                    createdByName?: string;
                }>();
            })()
        ]);

        const quotationApprovalCount = pendingQuotations.length < 20
            ? pendingQuotations.length
            : await this.quotationRepo.count({ where: quotationWhere });
        const contractApprovalCount = pendingContracts.length < 20
            ? pendingContracts.length
            : await this.contractRepo.count({ where: contractWhere });

        const totalCustomers = parseInt(metricsRow?.totalCustomers || "0", 10);
        const newCustomers = parseInt(metricsRow?.newCustomers || "0", 10);
        const totalRevenue = parseFloat(metricsRow?.totalRevenue || "0");
        const totalDebt = parseFloat(metricsRow?.totalDebt || "0");

        const approvalQueue = {
            quotations: pendingQuotations.map(q => ({
                id: q.id,
                type: "QUOTATION",
                title: `Báo giá lần ${q.version}`,
                status: q.status,
                totalAmount: parseFloat(String(q.totalAmount || "0")),
                createdAt: q.createdAt,
                opportunityId: q.opportunityId,
                opportunityCode: q.opportunityCode,
                opportunityName: q.opportunityName,
                customerName: q.customerName,
                createdByName: q.createdByName
            })),
            contracts: pendingContracts.map(c => ({
                id: c.id,
                type: "CONTRACT",
                title: c.title,
                status: c.status,
                totalAmount: parseFloat(String(c.totalAmount || "0")),
                createdAt: c.createdAt,
                contractCode: c.contractCode,
                opportunityId: c.opportunityId,
                opportunityName: c.opportunityName,
                customerName: c.customerName,
                createdByName: c.createdByName,
                proposalUrl: c.proposalUrl,
                quotationLink: c.quotationLink
            }))
        };

        return {
            totalCustomers,
            newCustomers,
            totalRevenue,
            totalDebt,
            approvalQueue,
            currentProjects: [] as any[],
            pendingApprovalCount: quotationApprovalCount + contractApprovalCount
        };
    }
}
