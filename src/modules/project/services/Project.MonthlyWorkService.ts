import { AppDataSource } from "../../../data-source";
import { Like, ILike, In, IsNull, Not } from "typeorm";
import { Projects, ProjectStatus } from "../entities/Project.entity";
import { Contracts, ContractStatus } from "../../contract/entities/Contract.entity";
import { ProjectTeams } from "../entities/ProjectTeam.entity";
import { TeamMembers, MemberRole } from "../entities/TeamMember.entity";
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

import { SecurityService } from "../../../shared/services/Security.Service";
import { isProjectManagementRole, isStaffRole, UserRole } from "../../account/entities/Account.entity";
import { projectEmitter, PROJECT_EVENTS } from "../events/ProjectEmitter";
import { opportunityEmitter, OPPORTUNITY_EVENTS } from "../../opportunity/events/OpportunityEmitter";
import { contractAddendumEmitter, CONTRACT_ADDENDUM_EVENTS } from "../../contract-addendum/events/ContractAddendumEmitter";
// Google Sheet integration is temporarily disabled.
// import { GoogleSheetService } from "../../../shared/services/GoogleSheet.Service";

import { ProjectBaseService } from "./Project.BaseService";

export class ProjectMonthlyWorkService extends ProjectBaseService {
    async getMonthlyWorkTemplate(id: string, monthKey?: string, userInfo?: { id: string, role: string, userId?: string }) {
        const normalizedMonthKey = this.assertMonthKey(monthKey);
        const project = await this.projectRepository.findOne({
            where: { id },
            relations: ["contract", "team", "team.teamLead", "team.members", "team.members.user"]
        });
        if (!project) throw new Error("Không tìm thấy dự án");
        if (!project.contract) throw new Error("Dự án chưa liên kết hợp đồng");
        if (!this.canCreateProjectWork(userInfo)) {
            throw new Error("Bạn không có quyền tạo công việc tháng mới cho dự án này");
        }

        const contractServices = await this.contractServiceRepository.find({
            where: {
                contract: { id: project.contract.id },
                addendum: IsNull()
            },
            relations: [
                "service",
                "service.serviceJobs",
                "service.serviceJobs.job",
                "opportunityService",
                "opportunityService.jobs",
                "opportunityService.jobs.job",
                "opportunityService.opportunityPackage"
            ],
            order: { packageName: "ASC", createdAt: "ASC" } as any
        });

        const items = contractServices.map(cs => this.mapContractServiceToMonthlyItem(cs));
        const packageMap = new Map<string, any>();
        const standalone: any[] = [];

        for (const item of items) {
            if (item.isPackageService && item.packageName) {
                if (!packageMap.has(item.packageKey)) {
                    packageMap.set(item.packageKey, {
                        packageKey: item.packageKey,
                        packageName: item.packageName,
                        packageQuantity: item.packageQuantity,
                        items: []
                    });
                }
                const packageGroup = packageMap.get(item.packageKey);
                const existingItem = packageGroup.items.find((groupItem: any) => groupItem.serviceId === item.serviceId);
                if (existingItem) {
                    existingItem.contractServiceIds.push(item.contractServiceId);
                    existingItem.sellingPrice += Number(item.sellingPrice || 0);
                    existingItem.cost += Number(item.cost || 0);
                } else {
                    packageGroup.items.push(item);
                }
            } else {
                const existingItem = standalone.find(groupItem => groupItem.serviceId === item.serviceId);
                if (existingItem) {
                    existingItem.contractServiceIds.push(item.contractServiceId);
                    existingItem.sellingPrice += Number(item.sellingPrice || 0);
                    existingItem.cost += Number(item.cost || 0);
                    existingItem.quantity += 1;
                } else {
                    standalone.push(item);
                }
            }
        }

        return {
            projectId: project.id,
            contractId: project.contract.id,
            monthKey: normalizedMonthKey,
            defaultName: `${project.name} - ${this.formatMonthName(normalizedMonthKey)}`,
            packages: Array.from(packageMap.values()),
            standalone
        };
    }

    async createMonthlyWorkAddendum(
        id: string,
        data: {
            monthKey?: string,
            name?: string,
            description?: string,
            items?: {
                contractServiceId?: string,
                serviceId?: string,
                serviceName?: string,
                packageName?: string,
                isPackageService?: boolean,
                sellingPrice?: number,
                cost?: number
            }[]
        },
        userInfo?: { id: string, role: string, userId?: string }
    ) {
        const monthKey = this.assertMonthKey(data.monthKey);
        const project = await this.projectRepository.findOne({
            where: { id },
            relations: ["contract", "team", "team.teamLead", "team.members", "team.members.user"]
        });
        if (!project) throw new Error("Không tìm thấy dự án");
        this.assertLoadedProjectNotOnHold(project);
        if (!project.contract) throw new Error("Dự án chưa liên kết hợp đồng");
        if (!this.canCreateProjectWork(userInfo)) {
            throw new Error("Bạn không có quyền tạo công việc tháng mới cho dự án này");
        }

        const requestedItems = data.items || [];
        if (requestedItems.length === 0) throw new Error("Vui lòng chọn ít nhất một dịch vụ");
        const requestedIds = Array.from(new Set(requestedItems.map(item => item.contractServiceId).filter(Boolean)));

        const existing = await this.addendumRepository.findOne({
            where: {
                contract: { id: project.contract.id },
                project: { id: project.id },
                type: AddendumType.MONTHLY_TASKS,
                monthKey,
                status: Not(In([AddendumStatus.SALE_REJECTED, AddendumStatus.BOD_REJECTED, AddendumStatus.CANCELLED]))
            }
        });
        if (existing) throw new Error(`Đã có phụ lục công việc tháng ${this.formatMonthName(monthKey)} đang chờ duyệt hoặc đã duyệt`);

        const contractServices = requestedIds.length > 0 ? await this.contractServiceRepository.find({
            where: requestedIds.map(contractServiceId => ({
                id: contractServiceId,
                contract: { id: project.contract.id },
                addendum: IsNull()
            })),
            relations: ["service"]
        }) : [];
        if (requestedIds.length > 0 && contractServices.length !== requestedIds.length) {
            throw new Error("Một số dịch vụ không hợp lệ hoặc không thuộc hợp đồng gốc");
        }

        const contractServiceMap = new Map(contractServices.map(cs => [cs.id, cs]));
        const selectedItems: any[] = [];

        for (const item of requestedItems) {
            if (item.contractServiceId) {
                const cs = contractServiceMap.get(item.contractServiceId);
                if (!cs) continue;
                selectedItems.push({
                    sourceContractServiceId: cs.id,
                    serviceId: cs.service?.id || cs.serviceId,
                    serviceName: cs.name || cs.service?.name || "Dịch vụ",
                    packageName: cs.packageName,
                    isPackageService: cs.isPackageService,
                    sellingPrice: Number(cs.sellingPrice || 0),
                    cost: Number(cs.service?.costPrice || 0)
                });
                continue;
            }

            if (!item.serviceId) throw new Error("Dịch vụ thêm mới không hợp lệ");
            const service = await AppDataSource.getRepository(Services).findOneBy({ id: item.serviceId });
            if (!service) throw new Error("Không tìm thấy dịch vụ thêm mới");
            selectedItems.push({
                sourceContractServiceId: null,
                serviceId: service.id,
                serviceName: item.serviceName || service.name,
                packageName: item.packageName,
                isPackageService: !!item.isPackageService,
                sellingPrice: Number(item.sellingPrice || 0),
                cost: Number(item.cost ?? service.costPrice ?? 0)
            });
        }

        if (selectedItems.length === 0) throw new Error("Vui lòng chọn ít nhất một dịch vụ");

        const addendum = this.addendumRepository.create({
            contract: project.contract,
            project,
            name: data.name || `${project.name} - ${this.formatMonthName(monthKey)}`,
            description: data.description,
            type: AddendumType.MONTHLY_TASKS,
            monthKey,
            selectedItems,
            sellingPrice: selectedItems.reduce((sum, item) => sum + Number(item.sellingPrice || 0), 0),
            cost: selectedItems.reduce((sum, item) => sum + Number(item.cost || 0), 0),
            status: AddendumStatus.PENDING_SALE
        });

        const saved = await this.addendumRepository.save(addendum);
        await this.notifyProjectStakeholders(project.id, {
            title: "Có phụ lục công việc tháng mới",
            content: `Dự án "${project.name}" vừa tạo phụ lục công việc tháng ${this.formatMonthName(monthKey)} và đang chờ Sale duyệt.`,
            type: "MONTHLY_WORK_ADDENDUM_CREATED",
            relatedEntityId: saved.id,
            relatedEntityType: "ContractAddendum"
        });
        projectEmitter.emit(PROJECT_EVENTS.UPDATED, project);
        contractAddendumEmitter.emit(CONTRACT_ADDENDUM_EVENTS.CREATED, saved);
        return saved;
    }
}
