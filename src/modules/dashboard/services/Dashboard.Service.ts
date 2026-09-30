import { AppDataSource } from "../../../data-source";
import { Contracts, ContractStatus } from "../../contract/entities/Contract.entity";
import { Customers } from "../../customer/entities/Customer.entity";
import { Debts, DebtStatus } from "../../debt/entities/Debt.entity";
import { Projects, ProjectStatus } from "../../project/entities/Project.entity";
import { ContractServiceStatus } from "../../contract/entities/ContractService.entity";
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

        // getAllStaffWorkloads() chạy 1 aggregate query trên toàn bộ task của toàn bộ staff - khá nặng.
        // Trước đây với Admin/BOD (canSelectMembers = true VÀ type = SYSTEM) hàm này bị gọi 2 LẦN
        // trong cùng 1 request (1 lần ở đây, 1 lần trong khối admin bên dưới). Giờ chỉ gọi tối đa 1 lần,
        // và chạy song song với getAdminMetrics (2 việc này độc lập, không cần chờ nhau).
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
                relations: ["contract", "contract.services"]
            })
            : [];

        if (ledProjects.length > 0) {
            data.teamLead = ledProjects.map(p => {
                const services = p.contract?.services || [];
                const totalServices = services.length;
                const completedServices = services.filter(s => s.status === ContractServiceStatus.COMPLETED).length;
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
                assignee: { id: true },
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
        const roleTaskBaseConditions: any[] = [];
        if (scope.type === DashboardScopeType.SYSTEM) {
            roleTaskBaseConditions.push({ ...(projectId && { project: { id: projectId } }) });
        } else if (scope.type === DashboardScopeType.MANAGEMENT) {
            roleTaskBaseConditions.push({ project: { id: projectId || In(scope.projectIds) } });
        } else {
            roleTaskBaseConditions.push({
                assignee: { id: userId },
                ...(projectId && { project: { id: projectId } })
            });
            roleTaskBaseConditions.push({
                helper: { id: userId },
                ...(projectId && { project: { id: projectId } })
            });
        }
        const taskWhereConditions = roleTaskBaseConditions.flatMap(condition =>
            this.withTaskPeriod(condition, dateFilter)
        );

        const rawRoleTasks = await this.taskRepo.find({
            where: taskWhereConditions,
            relations: ["project", "project.contract", "project.contract.customer", "project.contract.services", "assignee"],
            select: {
                id: true,
                name: true,
                nickname: true,
                status: true,
                code: true,
                plannedStartDate: true,
                plannedEndDate: true,
                assignee: { id: true },
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

        const roleTaskMap = new Map();
        rawRoleTasks.forEach(t => {
            if (t && t.id && !roleTaskMap.has(t.id)) roleTaskMap.set(t.id, t);
        });
        const activeRoleTasks = Array.from(roleTaskMap.values()).filter(t => !t.project || (t.project.status !== ProjectStatus.COMPLETED && t.project.status !== ProjectStatus.CANCELLED));
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
        const teamProjects = scope.projectIds.length > 0 ? await this.projectRepo.find({
            where: { id: In(scope.projectIds) },
            relations: ["contract", "contract.customer", "contract.services", "team", "team.teamLead", "team.members", "team.members.user"]
        }) : [];

        const projectMap = new Map();

        const addProjectToMap = (project: any) => {
            if (project && !projectMap.has(project.id)) {
                const services = project.contract?.services || [];
                const totalServices = services.length;
                const completedServices = services.filter(s => s.status === ContractServiceStatus.COMPLETED).length;

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

        data.member = {
            vinicoin,
            vinicoinTotal,
            vinicoinWithdrawn,
            workload: await this.workloadService.getWorkloadForUser(userId, month, year),
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

    private async getAdminMetrics(dateFilter: any | null, projectId?: string, month?: number, year?: number) {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const dateRange = this.getDateRange(month, year);

        const revenueQb = this.contractRepo.createQueryBuilder("contract")
            .select("COALESCE(SUM(contract.sellingPrice), 0)", "totalRevenue")
            .where("contract.status IN (:...statuses)", {
                statuses: [ContractStatus.SIGNED, ContractStatus.COMPLETED]
            });
        if (projectId) {
            revenueQb.innerJoin("contract.project", "project")
                .andWhere("project.id = :projectId", { projectId });
        }
        if (dateRange) revenueQb.andWhere("contract.createdAt BETWEEN :dStart AND :dEnd", {
            dStart: dateRange.start,
            dEnd: dateRange.end
        });

        const debtQb = this.debtRepo.createQueryBuilder("debt")
            .leftJoin("debt.payments", "payment")
            .select("debt.id", "debtId")
            .addSelect("debt.amount", "amount")
            .addSelect("COALESCE(SUM(payment.amount), 0)", "paidAmount")
            .where("debt.status IN (:...statuses)", {
                statuses: [DebtStatus.UNPAID, DebtStatus.PARTIAL]
            })
            .groupBy("debt.id")
            .addGroupBy("debt.amount");
        if (projectId) {
            debtQb.innerJoin("debt.contract", "contract")
                .innerJoin("contract.project", "project")
                .andWhere("project.id = :projectId", { projectId });
        }

        const [totalCustomers, newCustomers, revenueResult, debtResult] = await Promise.all([
            this.customerRepo.count({
                where: {
                    ...(projectId && { contracts: { project: { id: projectId } } }),
                    ...(dateFilter && { createdAt: dateFilter })
                } as any
            }),
            this.customerRepo.count({
                where: {
                    ...(projectId && { contracts: { project: { id: projectId } } }),
                    createdAt: Between(thirtyDaysAgo, new Date())
                } as any
            }),
            revenueQb.getRawOne<{ totalRevenue: string }>(),
            debtQb.getRawMany<{ debtId: string; amount: string; paidAmount: string }>()
        ]);

        const totalRevenue = parseFloat(revenueResult?.totalRevenue || "0");
        const totalDebt = debtResult.reduce((sum, row) => {
            const remaining = parseFloat(row.amount) - parseFloat(row.paidAmount || "0");
            return sum + Math.max(0, remaining);
        }, 0);

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

        const [pendingQuotations, pendingContracts, quotationApprovalCount, contractApprovalCount] = await Promise.all([
            this.quotationRepo.find({
                where: quotationWhere,
                relations: ["opportunity", "opportunity.customer", "opportunity.createdBy", "createdBy"],
                order: { createdAt: "DESC" },
                take: 20
            }),
            this.contractRepo.find({
                where: contractWhere,
                relations: ["customer", "opportunity", "createdBy"],
                order: { createdAt: "DESC" },
                take: 20
            }),
            this.quotationRepo.count({ where: quotationWhere }),
            this.contractRepo.count({ where: contractWhere })
        ]);

        const approvalQueue = {
            quotations: pendingQuotations.map(q => ({
                id: q.id,
                type: "QUOTATION",
                title: `Báo giá lần ${q.version}`,
                status: q.status,
                totalAmount: q.totalAmount,
                createdAt: q.createdAt,
                opportunityId: q.opportunity?.id,
                opportunityCode: q.opportunity?.opportunityCode,
                opportunityName: q.opportunity?.name,
                customerName: q.opportunity?.customer?.name || q.opportunity?.leadName,
                createdByName: q.createdBy?.fullName || q.opportunity?.createdBy?.fullName
            })),
            contracts: pendingContracts.map(c => ({
                id: c.id,
                type: "CONTRACT",
                title: c.name,
                status: c.status,
                totalAmount: c.sellingPrice,
                createdAt: c.createdAt,
                contractCode: c.contractCode,
                opportunityId: c.opportunity?.id,
                opportunityName: c.opportunity?.name,
                customerName: c.customer?.name,
                createdByName: c.createdBy?.fullName,
                proposalUrl: c.proposal_contract,
                quotationLink: c.quotation_link
            }))
        };

        const currentProjects = await this.getCurrentProjectProgress(projectId);

        return {
            totalCustomers,
            newCustomers,
            totalRevenue,
            totalDebt,
            approvalQueue,
            currentProjects,
            pendingApprovalCount: quotationApprovalCount + contractApprovalCount
        };
    }

    private async getCurrentProjectProgress(projectId?: string) {
        const projects = await this.projectRepo.find({
            where: {
                ...(projectId && { id: projectId }),
                status: In([
                    ProjectStatus.PENDING_CONFIRMATION,
                    ProjectStatus.CONFIRMED,
                    ProjectStatus.IN_PROGRESS
                ])
            },
            relations: ["contract", "contract.customer", "contract.services", "team", "team.teamLead"],
            order: { createdAt: "DESC" }
        });

        return projects.map(project => {
            const services = project.contract?.services || [];
            const serviceCount = services.length;
            const completedServiceCount = services.filter(s => s.status === ContractServiceStatus.COMPLETED).length;

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
}
