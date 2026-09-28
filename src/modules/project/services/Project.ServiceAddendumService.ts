import { AppDataSource } from "../../../data-source";
import { AddendumStatus, AddendumType, ContractAddendums } from "../../contract-addendum/entities/ContractAddendum.entity";
import { Services } from "../../service/entities/Service.entity";
import { SecurityService } from "../../../shared/services/Security.Service";
import { projectEmitter, PROJECT_EVENTS } from "../events/ProjectEmitter";
import { contractAddendumEmitter, CONTRACT_ADDENDUM_EVENTS } from "../../contract-addendum/events/ContractAddendumEmitter";
import { ProjectBaseService } from "./Project.BaseService";

type AddServiceItem = {
    serviceId?: string;
    serviceName?: string;
    quantity?: number;
    packageKey?: string;
    packageName?: string;
    packageQuantity?: number;
    isPackageService?: boolean;
    sellingPrice?: number;
    cost?: number;
};

export class ProjectServiceAddendumService extends ProjectBaseService {
    async createServiceAddendum(
        id: string,
        data: {
            name?: string;
            description?: string;
            items?: AddServiceItem[];
        },
        userInfo?: { id: string, role: string, userId?: string }
    ) {
        const project = await this.projectRepository.findOne({
            where: { id },
            relations: ["contract", "team", "team.teamLead"]
        });
        if (!project) throw new Error("Không tìm thấy dự án");
        this.assertLoadedProjectNotOnHold(project);
        if (!project.contract) throw new Error("Dự án chưa liên kết hợp đồng");

        if (!this.canCreateProjectWork(userInfo)) {
            throw new Error("Bạn không có quyền bổ sung dịch vụ cho dự án này");
        }

        const requestedItems = data.items || [];
        if (requestedItems.length === 0) throw new Error("Vui lòng chọn ít nhất một dịch vụ");

        if (requestedItems.some(item => !item.serviceId)) {
            throw new Error("Danh sách dịch vụ bổ sung không hợp lệ");
        }

        const serviceIds = Array.from(new Set(requestedItems.map(item => item.serviceId))) as string[];
        const services = await AppDataSource.getRepository(Services).find({
            where: serviceIds.map(serviceId => SecurityService.withTenant({ id: serviceId }, userInfo) as any),
            relations: ["serviceJobs", "serviceJobs.job"]
        });
        if (services.length !== serviceIds.length) {
            throw new Error("Một số dịch vụ không tồn tại hoặc không thuộc quyền truy cập");
        }

        const serviceMap = new Map(services.map(service => [service.id, service]));
        const selectedItems = requestedItems.map(item => {
            const service = serviceMap.get(item.serviceId as string);
            if (!service) throw new Error("Không tìm thấy dịch vụ bổ sung");

            const quantity = Number(item.quantity || 1);
            if (!Number.isInteger(quantity) || quantity <= 0) {
                throw new Error("Số lượng dịch vụ phải là số nguyên dương");
            }

            const unitPrice = item.sellingPrice !== undefined ? Number(item.sellingPrice) : Number(service.costPrice || 0);
            if (!Number.isFinite(unitPrice) || unitPrice < 0) {
                throw new Error("Đơn giá dịch vụ không hợp lệ");
            }

            const unitCost = item.cost !== undefined ? Number(item.cost) : Number(service.costPrice || 0);
            if (!Number.isFinite(unitCost) || unitCost < 0) {
                throw new Error("Giá vốn dịch vụ không hợp lệ");
            }

            return {
                sourceContractServiceId: null,
                serviceId: service.id,
                serviceName: item.serviceName || service.name,
                quantity,
                packageKey: item.packageKey,
                packageName: item.packageName,
                packageQuantity: item.packageQuantity,
                isPackageService: !!item.isPackageService,
                sellingPrice: unitPrice,
                cost: unitCost,
                unit: service.unit || "",
                description: service.description
            };
        });

        const addendum = this.addendumRepository.create({
            contract: project.contract,
            project,
            name: data.name || `${project.name} - Phụ lục bổ sung dịch vụ`,
            description: data.description,
            type: AddendumType.ADD_SERVICES,
            selectedItems,
            sellingPrice: selectedItems.reduce((sum, item) => sum + Number(item.sellingPrice || 0) * Number(item.quantity || 1), 0),
            cost: selectedItems.reduce((sum, item) => sum + Number(item.cost || 0) * Number(item.quantity || 1), 0),
            status: AddendumStatus.PENDING_SALE,
            ...SecurityService.getTenantWhere(userInfo)
        } as any);

        const saved = await this.addendumRepository.save(addendum) as unknown as ContractAddendums;
        await this.notifyProjectStakeholders(project.id, {
            title: "Có dịch vụ phát sinh mới",
            content: `Dự án "${project.name}" vừa được tạo yêu cầu thêm dịch vụ "${saved.name}".`,
            type: "SERVICE_ADDENDUM_CREATED",
            relatedEntityId: saved.id,
            relatedEntityType: "ContractAddendum"
        });
        projectEmitter.emit(PROJECT_EVENTS.UPDATED, project);
        contractAddendumEmitter.emit(CONTRACT_ADDENDUM_EVENTS.CREATED, saved);
        return saved;
    }
}
