import { AppDataSource } from "../../../data-source";
import { EntityManager, Like, ILike, In, IsNull, Not } from "typeorm";
import { Projects, ProjectStatus } from "../entities/Project.entity";
import { Contracts, ContractStatus } from "../../contract/entities/Contract.entity";
import { ProjectTeams } from "../entities/ProjectTeam.entity";
import { TeamMembers, MemberRole, memberHasRole } from "../entities/TeamMember.entity";
import { TeamMemberRoles } from "../entities/TeamMemberRole.entity";
import { Users } from "../../user/entities/User.entity";
import { OpportunityStatus } from "../../opportunity/entities/Opportunity.entity";
import { ContractServices } from "../../contract/entities/ContractService.entity";
import { AddendumStatus, AddendumType, ContractAddendums } from "../../contract-addendum/entities/ContractAddendum.entity";
import { Services } from "../../service/entities/Service.entity";
import { Tasks } from "../../task/entities/Task.entity";
import { TaskStatus } from "../../../shared/entities/Enums";
import { Jobs } from "../../job/entities/Job.entity";
import { PerformerType } from "../../../shared/entities/Enums";
import { NotificationService } from "../../notification/services/Notification.Service";
import { buildDefaultTaskNickname } from "../../../shared/helpers/TaskNickname.helper";
import { OpportunityServices } from "../../opportunity-service/entities/OpportunityService.entity";

import { SecurityService } from "../../../shared/services/Security.Service";
import { isManagementRole, isStaffRole, UserRole } from "../../account/entities/Account.entity";
import { projectEmitter, PROJECT_EVENTS } from "../events/ProjectEmitter";
import { opportunityEmitter, OPPORTUNITY_EVENTS } from "../../opportunity/events/OpportunityEmitter";
import { assertTaskProjectNotOnHold, assertProjectNotOnHold } from "../helpers/ProjectHold.helper";
import { assertBdOwnsProjectContract } from "../helpers/ProjectOwnership.helper";
// Google Sheet integration is temporarily disabled.
// import { GoogleSheetService } from "../../../shared/services/GoogleSheet.Service";

export class ProjectBaseService {
    protected projectRepository = AppDataSource.getRepository(Projects);
    protected contractRepository = AppDataSource.getRepository(Contracts);
    protected teamRepository = AppDataSource.getRepository(ProjectTeams);
    protected memberRepository = AppDataSource.getRepository(TeamMembers);
    protected memberRoleRepository = AppDataSource.getRepository(TeamMemberRoles);
    protected contractServiceRepository = AppDataSource.getRepository(ContractServices);
    protected opportunityServiceRepository = AppDataSource.getRepository(OpportunityServices);
    protected addendumRepository = AppDataSource.getRepository(ContractAddendums);
    protected taskRepository = AppDataSource.getRepository(Tasks);
    protected userRepository = AppDataSource.getRepository(Users);
    protected notificationService = new NotificationService();
    // private googleSheetService = new GoogleSheetService();

    protected httpError(message: string, statusCode: number) {
        const error: any = new Error(message);
        error.statusCode = statusCode;
        return error;
    }

    /**
     * Chặn thao tác ghi lên dự án đang tạm dừng (ON_HOLD).
     * Gọi ở đầu mỗi service method có ghi dữ liệu dự án/task; KHÔNG gọi ở luồng resume/close.
     */
    protected async assertProjectNotOnHold(projectIds: (string | null | undefined)[], manager?: any) {
        return assertProjectNotOnHold(this.projectRepository, projectIds, manager);
    }

    /**
     * Biến thể dùng khi đã có sẵn `project` đã load.
     */
    protected assertLoadedProjectNotOnHold(project: { id: string; name: string; status: ProjectStatus } | null | undefined) {
        return assertTaskProjectNotOnHold({ project });
    }

    /**
     * Guard cho đường **BD ĐÓNG DỰ ÁN TRỰC TIẾP** (`POST /projects/:id/close/direct`).
     *
     * ⚠️ Trước đây helper này dùng cho đường "BD tạm dừng trực tiếp" — đường đó
     * KHÔNG còn tồn tại (BD nay phải xin phép như PM). Logic không đổi, chỉ đổi
     * mục đích sử dụng.
     *
     * BD không thuộc PROJECT_MANAGEMENT_ROLES nên phải kiểm tra tường minh.
     * Caller phải tự cho BOD/ADMIN qua trước khi gọi helper này.
     */
    protected async assertBdOwnsProjectContract(
        actor: { id?: string; userId?: string; role?: string } | undefined,
        projectId: string
    ) {
        return assertBdOwnsProjectContract(this.contractRepository, actor, projectId);
    }

    protected assertMonthKey(monthKey?: string) {
        const value = monthKey || new Date().toISOString().slice(0, 7);
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
            throw new Error("Tháng không hợp lệ, định dạng cần là YYYY-MM");
        }
        return value;
    }

    protected formatMonthName(monthKey: string) {
        const [year, month] = monthKey.split("-");
        return `${month}/${year}`;
    }

    protected canManageMonthlyWork(project: Projects, userInfo?: { id: string, role: string, userId?: string }) {
        if (!userInfo) return false;
        if (isManagementRole(userInfo.role)) return true;
        const actorUserId = userInfo.userId || userInfo.id;
        if (userInfo.role === UserRole.PM) {
            return project.team?.members?.some(member =>
                member.user?.id === actorUserId && memberHasRole(member, MemberRole.PROJECT_MANAGER)
            ) || false;
        }
        return project.team?.teamLead?.id === actorUserId;
    }

    protected canCreateProjectWork(userInfo?: { id: string, role: string, userId?: string }) {
        if (!userInfo) return false;
        return [UserRole.ADMIN, UserRole.PM].includes(userInfo.role as UserRole);
    }

    protected mapContractServiceToMonthlyItem(cs: ContractServices) {
        const opportunityPackage = cs.opportunityService?.opportunityPackage;
        const packageQuantity = Number(opportunityPackage?.quantity || 1);
        const serviceQuantity = Number(cs.opportunityService?.quantity || 1);
        const opportunityJobs = cs.opportunityService?.jobs || [];
        const selectedJobIds = opportunityJobs.length > 0
            ? new Set(opportunityJobs.map(item => item.jobId))
            : null;
        const serviceJobs = (cs.service?.serviceJobs || []).filter(serviceJob =>
            !serviceJob.job?.isBriefVideo &&
            (!selectedJobIds || selectedJobIds.has(serviceJob.jobId))
        );

        return {
            contractServiceId: cs.id,
            contractServiceIds: [cs.id],
            serviceId: cs.service?.id || cs.serviceId,
            serviceCode: cs.code || cs.service?.code || null,
            serviceName: cs.name || cs.service?.name || "Dịch vụ",
            serviceNickname: cs.nickname,
            packageKey: opportunityPackage?.id || cs.packageName || cs.id,
            packageName: cs.packageName,
            packageQuantity,
            quantity: cs.isPackageService && packageQuantity > 0 ? serviceQuantity / packageQuantity : 1,
            isPackageService: cs.isPackageService,
            sellingPrice: Number(cs.sellingPrice || 0),
            cost: Number(cs.service?.costPrice || 0),
            unit: cs.service?.unit || "",
            description: cs.service?.description,
            jobs: serviceJobs.map(sj => ({
                jobId: sj.job?.id,
                jobName: sj.job?.name,
                quantity: Number(sj.quantity || 1),
                isOutput: sj.isOutput
            })).filter(job => !!job.jobId)
        };
    }

    protected emptySyncResult() {
        return {
            createdContractServices: 0,
            updatedContractServices: 0,
            createdTasks: 0,
            updatedOutputTasks: 0,
            backfilledResults: 0
        };
    }

    protected async syncContractServices(projectId: string) {
        const syncResult = {
            createdContractServices: 0,
            updatedContractServices: 0
        };

        const project = await this.projectRepository.findOne({
            where: { id: projectId },
            relations: ["contract", "contract.opportunity"]
        });
        if (!project) throw new Error("Không tìm thấy dự án");
        if (!project.contract) throw new Error("Dự án chưa liên kết hợp đồng");

        const contract = project.contract;
        const contractServices = await this.contractServiceRepository.find({
            where: { contract: { id: contract.id } },
            relations: ["service", "opportunityService"]
        });

        const updateContractServiceSnapshot = async (
            contractService: ContractServices,
            source?: { opportunityService?: OpportunityServices | null, service?: Services | null }
        ) => {
            const opportunityService = source?.opportunityService || contractService.opportunityService;
            const service = source?.service || opportunityService?.service || contractService.service;
            let changed = false;

            if (service && contractService.service?.id !== service.id) {
                contractService.service = service;
                contractService.serviceId = service.id;
                changed = true;
            } else if (service?.id && contractService.serviceId !== service.id) {
                contractService.serviceId = service.id;
                changed = true;
            }

            if (opportunityService && contractService.opportunityService?.id !== opportunityService.id) {
                contractService.opportunityService = opportunityService;
                changed = true;
            }

            const nextName = opportunityService?.name || service?.name;
            if (!contractService.name && nextName) {
                contractService.name = nextName;
                changed = true;
            }

            const nextCode = service?.code || null;
            if (nextCode && contractService.code !== nextCode) {
                contractService.code = nextCode;
                changed = true;
            }

            if (opportunityService) {
                if (contractService.packageName !== opportunityService.packageName) {
                    contractService.packageName = opportunityService.packageName;
                    changed = true;
                }
                if (contractService.isPackageService !== opportunityService.isPackageService) {
                    contractService.isPackageService = opportunityService.isPackageService;
                    changed = true;
                }
            }

            if (!changed) return;
            await this.contractServiceRepository.save(contractService);
            syncResult.updatedContractServices += 1;
        };

        if (contract.opportunity?.id) {
            const opportunityServices = await this.opportunityServiceRepository.find({
                where: { opportunity: { id: contract.opportunity.id } },
                relations: ["service", "opportunity"]
            });

            const usedContractServiceIds = new Set<string>();
            for (const opportunityService of opportunityServices) {
                const matchingContractServices = contractServices.filter((contractService) => {
                    if (usedContractServiceIds.has(contractService.id)) return false;
                    if (contractService.opportunityService?.id === opportunityService.id) return true;
                    return contractService.serviceId === opportunityService.serviceId &&
                        contractService.isPackageService === opportunityService.isPackageService &&
                        (!opportunityService.isPackageService || contractService.packageName === opportunityService.packageName);
                });

                for (const contractService of matchingContractServices) {
                    usedContractServiceIds.add(contractService.id);
                    await updateContractServiceSnapshot(contractService, {
                        opportunityService,
                        service: opportunityService.service
                    });
                }

                const requiredQuantity = Number(opportunityService.quantity || 1);
                for (let i = matchingContractServices.length; i < requiredQuantity; i++) {
                    const contractService = this.contractServiceRepository.create({
                        contract,
                        service: opportunityService.service,
                        serviceId: opportunityService.service?.id || opportunityService.serviceId,
                        sellingPrice: opportunityService.sellingPrice,
                        opportunityService,
                        name: opportunityService.name || opportunityService.service?.name,
                        code: opportunityService.service?.code,
                        packageName: opportunityService.packageName,
                        isPackageService: opportunityService.isPackageService
                    } as any) as unknown as ContractServices;
                    const savedContractService = await this.contractServiceRepository.save(contractService) as ContractServices;
                    contractServices.push(savedContractService);
                    usedContractServiceIds.add(savedContractService.id);
                    syncResult.createdContractServices += 1;
                }
            }
        }

        for (const contractService of contractServices) {
            await updateContractServiceSnapshot(contractService);
        }

        return syncResult;
    }

    protected buildContractServiceResult(task: Tasks) {
        return {
            taskId: task.id,
            type: task.result?.type || 'file',
            name: task.result?.name || task.nickname || task.name || task.code,
            url: task.result?.url,
            note: task.result?.note,
            checklist: task.result?.checklist,
            status: 'PENDING' as const
        };
    }

    protected async notifyProjectStakeholders(
        projectId: string,
        data: { title: string, content: string, type: string, relatedEntityId?: string, relatedEntityType?: string },
        manager?: EntityManager
    ) {
        const projectRepository = manager
            ? manager.getRepository(Projects)
            : this.projectRepository;
        const project = await projectRepository.findOne({
            where: { id: projectId },
            relations: [
                "contract",
                "contract.createdBy",
                "contract.createdBy.accounts",
                "contract.opportunity",
                "contract.opportunity.createdBy",
                "contract.opportunity.createdBy.accounts",
                "contract.customer",
                "contract.customer.createdBy",
                "contract.customer.createdBy.accounts",
                "team",
                "team.members",
                "team.members.roles",
                "team.members.user"
            ]
        });
        if (!project) return;

        const recipients: Users[] = [];
        const addRecipient = (user?: Users | null) => {
            if (user?.id && !recipients.some(item => item.id === user.id)) {
                recipients.push(user);
            }
        };
        const addBdRecipient = (user?: Users | null) => {
            const isBd = user?.accounts?.some(account => account.role === UserRole.BD);
            if (isBd) addRecipient(user);
        };

        addBdRecipient(project.contract?.createdBy);
        addBdRecipient(project.contract?.opportunity?.createdBy);
        addBdRecipient(project.contract?.customer?.createdBy);

        for (const member of project.team?.members || []) {
            if (
                memberHasRole(member, MemberRole.ACCOUNT) ||
                memberHasRole(member, MemberRole.PROJECT_MANAGER)
            ) {
                addRecipient(member.user);
            }
        }

        for (const recipient of recipients) {
            await this.notificationService.createNotification({
                title: data.title,
                content: data.content,
                type: data.type,
                recipient,
                relatedEntityId: data.relatedEntityId,
                relatedEntityType: data.relatedEntityType,
                link: `/projects/${project.id}`
            }, manager);
        }
    }

    protected shouldBackfillResult(task: Tasks) {
        return task.isOutput &&
            !!task.contractService &&
            !!task.result &&
            [TaskStatus.INTERNAL_COMPLETED, TaskStatus.COMPLETED, TaskStatus.ACCEPTED].includes(task.status);
    }

    protected async syncContractServiceJobs(projectId: string, options: { allowCompletedProject?: boolean } = {}) {
        const syncResult = this.emptySyncResult();

        const project = await this.projectRepository.findOne({
            where: { id: projectId },
            relations: ["contract"]
        });
        if (!project) throw new Error("Không tìm thấy dự án");
        if (!project.contract) throw new Error("Dự án chưa liên kết hợp đồng");
        if (!options.allowCompletedProject &&
            [ProjectStatus.COMPLETED, ProjectStatus.CANCELLED].includes(project.status)) {
            throw new Error("Dự án đã hoàn tất hoặc đã hủy, không thể đồng bộ công việc");
        }

        const contract = await this.contractRepository.findOne({
            where: { id: project.contract.id },
            relations: ["opportunity"]
        });
        if (!contract) throw new Error("Không tìm thấy hợp đồng");

        const opportunityServices = contract.opportunity
            ? await this.opportunityServiceRepository.find({
                where: { opportunity: { id: contract.opportunity.id } },
                relations: ["jobs", "jobs.job"]
            })
            : [];

        const contractServices = await this.contractServiceRepository.find({
            where: { contract: { id: contract.id } },
            relations: [
                "service",
                "service.serviceJobs",
                "service.serviceJobs.job",
                "opportunityService",
                "opportunityService.jobs",
                "opportunityService.jobs.job",
                "tasks",
                "tasks.job"
            ]
        });

        for (const cs of contractServices) {
            if (!cs.service?.serviceJobs?.length) continue;

            const opportunityService = cs.opportunityService || opportunityServices.find(item =>
                item.serviceId === cs.serviceId &&
                item.isPackageService === cs.isPackageService &&
                (!cs.isPackageService || item.packageName === cs.packageName)
            );
            const opportunityJobs = opportunityService?.jobs || [];
            const selectedJobIds = opportunityJobs.length > 0
                ? new Set(opportunityJobs.map(item => item.jobId))
                : null;
            const serviceJobs = cs.service.serviceJobs.filter(serviceJob =>
                !serviceJob.job?.isBriefVideo &&
                (!selectedJobIds || selectedJobIds.has(serviceJob.jobId))
            );

            for (const sj of serviceJobs) {
                const job = sj.job;
                if (!job) continue;

                const quantity = Number(sj.quantity || 1);
                const existingTasks = (cs.tasks || []).filter(task => task.job?.id === job.id);

                if (sj.isOutput) {
                    for (const task of existingTasks) {
                        if (!task.isOutput) {
                            task.isOutput = true;
                            await this.taskRepository.save(task);
                            syncResult.updatedOutputTasks += 1;
                        }
                    }
                }

                for (let i = existingTasks.length; i < quantity; i++) {
                    const totalCountForProject = await this.taskRepository.count({
                        where: {
                            project: { id: project.id },
                            job: { id: job.id }
                        }
                    });

                    const sequenceNumber = totalCountForProject + 1;
                    const seq = sequenceNumber.toString().padStart(2, '0');
                    const serviceCode = cs.code || cs.service?.code;
                    const jobCode = job.code || `JOB${job.id}`;
                    const taskCode = [contract.contractCode, serviceCode, jobCode, seq].filter(Boolean).join("-");

                    const task = this.taskRepository.create({
                        code: taskCode,
                        name: job.name,
                        nickname: buildDefaultTaskNickname(job, sequenceNumber),
                        project,
                        job,
                        contractService: cs,
                        status: TaskStatus.PENDING,
                        performerType: job.defaultPerformerType,
                        attachments: contract.attachments || [],
                        isOutput: sj.isOutput
                    });

                    const savedTask = await this.taskRepository.save(task);
                    existingTasks.push(savedTask);
                    syncResult.createdTasks += 1;
                }
            }

            const outputTasks = await this.taskRepository.find({
                where: {
                    project: { id: project.id },
                    contractService: { id: cs.id },
                    isOutput: true
                },
                relations: ["contractService"]
            });

            const results = Array.isArray(cs.results) ? [...cs.results] : [];
            let serviceBackfilledResults = 0;
            for (const task of outputTasks) {
                if (!this.shouldBackfillResult(task)) continue;

                const resultIndex = results.findIndex(result => result.taskId === task.id);
                const result = this.buildContractServiceResult(task);
                if (resultIndex >= 0) {
                    const current = results[resultIndex];
                    if (!current.url && result.url) {
                        results[resultIndex] = { ...current, ...result };
                        syncResult.backfilledResults += 1;
                        serviceBackfilledResults += 1;
                    }
                } else {
                    results.push(result);
                    syncResult.backfilledResults += 1;
                    serviceBackfilledResults += 1;
                }
            }

            if (serviceBackfilledResults > 0) {
                cs.results = results;
                await this.contractServiceRepository.save(cs);
            }
        }

        return syncResult;
    }


    async getOne(id: string, userInfo?: { id: string, role: string, userId?: string }) {
        let rbacWhere: any = {};
        if (userInfo) {
            rbacWhere = SecurityService.getProjectFilters(userInfo);
            // If rbacWhere is an array (OR conditions), we need to wrap the find with those conditions
            if (Array.isArray(rbacWhere)) {
                rbacWhere = rbacWhere.map(cond => ({ id, ...cond }));
            } else {
                rbacWhere = { id, ...rbacWhere };
            }
        } else {
            rbacWhere = { id };
        }

        const project = await this.projectRepository.findOne({
            where: rbacWhere,
            relations: [
                "contract",
                "contract.createdBy",
                "contract.opportunity",
                "contract.opportunity.createdBy",
                "contract.customer",
                "contract.customer.createdBy",
                "team",
                "team.teamLead",
                "team.members",
                "team.members.roles",
                "team.members.user",
                "team.members.user.accounts",
                "confirmedBy"
            ],
            select: {
                id: true,
                name: true,
                status: true,
                plannedStartDate: true,
                plannedEndDate: true,
                autoAcceptAt: true,
                pausedAt: true,
                pausedById: true,
                isOnHold: true,
                currentPauseRequestId: true,
                googleSheetId: true,
                googleSheetUrl: true,
                googleSheetStatus: true,
                googleSheetError: true,
                googleSheetCreatedAt: true,
                workingFiles: true,
                confirmedById: true,
                confirmedAt: true,
                confirmedBy: {
                    id: true,
                    fullName: true
                },
                contract: {
                    id: true,
                    name: true,
                    contractCode: true,
                    attachments: true,
                    status: true,
                    description: true,
                    createdBy: {
                        id: true,
                        fullName: true
                    },
                    opportunity: {
                        id: true,
                        name: true,
                        opportunityCode: true,
                        createdBy: {
                            id: true,
                            fullName: true
                        }
                    },
                    customer: {
                        id: true,
                        name: true,
                        createdBy: {
                            id: true,
                            fullName: true
                        }
                    }
                },
                team: {
                    id: true,
                    name: true,
                    teamLead: {
                        id: true,
                        fullName: true,
                        phoneNumber: true,
                    },
                    members: {
                        id: true,
                        roles: {
                            id: true,
                            role: true
                        },
                        user: {
                            id: true,
                            fullName: true,
                            phoneNumber: true,
                            accounts: {
                                id: true,
                                role: true
                            }
                        }
                    }
                },
                // Quan hệ ManyToOne — cần cho banner "Người tạm dừng"
                pausedBy: {
                    id: true,
                    fullName: true
                }
            }
        });

        if (!project) {
            if (userInfo?.role === UserRole.PM) {
                const exists = await this.projectRepository.exist({ where: { id } });
                if (exists) throw new Error("FORBIDDEN_ACCESS");
            }
            throw new Error("Không tìm thấy dự án");
        }

        // Tải các task riêng biệt để tránh tình trạng Cartesian product làm chậm câu truy vấn
        project.tasks = await this.taskRepository.find({
            where: { project: { id: project.id } },
            relations: ["assignee", "job", "quotation", "parentTask"]
        });

        // Tải danh sách dịch vụ của hợp đồng riêng biệt
        if (project.contract) {
            project.contract.services = await this.contractServiceRepository.find({
                where: { contract: { id: project.contract.id } },
                relations: ["service", "tasks", "tasks.job", "tasks.assignee", "tasks.helper"],
                select: {
                    id: true,
                    sellingPrice: true,
                    status: true,
                    results: true,
                    name: true,
                    nickname: true,
                    code: true,
                    packageName: true,
                    isPackageService: true,
                    service: {
                        id: true,
                        name: true
                    },
                    tasks: {
                        id: true,
                        name: true,
                        nickname: true,
                        status: true,
                        result: true,
                        code: true,
                        isOutput: true,
                        assigneeId: true,
                        helperId: true,
                        plannedEndDate: true,
                        assignee: {
                            id: true,
                            fullName: true
                        },
                        helper: {
                            id: true,
                            fullName: true
                        }
                    }
                }
            });
        }

        // Filter out system attachments that handled by separate fields
        if (project.contract && project.contract.attachments) {
            project.contract.attachments = project.contract.attachments.filter(
                att => att.type !== "PROPOSAL_CONTRACT" && att.type !== "SIGNED_CONTRACT"
            );
        }

        // Data Restriction for Support Teams
        if (userInfo && isStaffRole(userInfo.role) && project.team) {
            const isCoreMember = project.team.teamLead?.id === userInfo.userId ||
                project.team.members?.some(m => m.user?.id === userInfo.userId);

            if (!isCoreMember) {
                // Filter tasks: Only show tasks where the user is involved
                project.tasks = project.tasks.filter(t =>
                    t.assigneeId === userInfo.userId ||
                    t.helperId === userInfo.userId ||
                    t.supportLeadId === userInfo.userId
                );

                // Mask sensitive contract info
                if (project.contract) {
                    if (project.contract.services) {
                        project.contract.services.forEach(s => {
                            s.sellingPrice = 0;
                        });
                    }
                }
            }
        }

        // Filter contract service tasks for non-lead / non-PM users of this project
        if (userInfo && project.contract?.services) {
            const isAdminOrBod = userInfo.role === UserRole.ADMIN || userInfo.role === UserRole.BOD;
            const isProjectLead = project.team?.teamLead?.id === userInfo.userId;
            const isProjectManager = project.team?.members?.some(
                m => memberHasRole(m, MemberRole.PROJECT_MANAGER) && m.user?.id === userInfo.userId
            );

            if (!isAdminOrBod && !isProjectLead && !isProjectManager) {
                project.contract.services.forEach(s => {
                    if (Array.isArray(s.tasks)) {
                        s.tasks = s.tasks.filter(t =>
                            t.assigneeId === userInfo.userId ||
                            t.helperId === userInfo.userId ||
                            t.assignee?.id === userInfo.userId ||
                            t.helper?.id === userInfo.userId
                        );
                    }
                });
                project.contract.services = project.contract.services.filter(
                    s => Array.isArray(s.tasks) && s.tasks.length > 0
                );
            }
        }

        return project;
    }
}
