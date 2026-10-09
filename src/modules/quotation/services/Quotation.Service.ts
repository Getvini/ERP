import { AppDataSource } from "../../../data-source";
import { Quotations, QuotationStatus, QuotationType } from "../entities/Quotation.entity";
import { QuotationDetails } from "../entities/QuotationDetail.entity";
import { Opportunities, OpportunityStatus } from "../../opportunity/entities/Opportunity.entity";
import { Services } from "../../service/entities/Service.entity";
import { Tasks } from "../../task/entities/Task.entity";
import { PricingStatus, TaskStatus } from "../../../shared/entities/Enums";
import { ContractAddendums, AddendumStatus } from "../../contract-addendum/entities/ContractAddendum.entity";
import { Users } from "../../user/entities/User.entity";
import { UserRole } from "../../account/entities/Account.entity";
import { NotificationService } from "../../notification/services/Notification.Service";
import { quotationEmitter, QUOTATION_EVENTS } from "../events/QuotationEmitter";
import { opportunityEmitter, OPPORTUNITY_EVENTS } from "../../opportunity/events/OpportunityEmitter";
import { ContractService } from "../../contract/services/Contract.Service";
import { calculatePricingTotals, roundUnitSellingPrice } from "../../../shared/helpers/PricingTax.helper";
import { title } from "node:process";
import { OpportunityServices } from "../../opportunity-service/entities/OpportunityService.entity";

type QuotationActor = { id: string, role: string, userId?: string, companyId?: string };

export class QuotationService {
    private quotationRepository = AppDataSource.getRepository(Quotations);
    private quotationDetailRepository = AppDataSource.getRepository(QuotationDetails);
    private opportunityRepository = AppDataSource.getRepository(Opportunities);
    private taskRepository = AppDataSource.getRepository(Tasks);
    private opportunityServiceRepository = AppDataSource.getRepository(OpportunityServices);
    private notificationService = new NotificationService();
    private contractService = new ContractService();

    private async getUsersByRoles(roles: UserRole[]) {
        return await AppDataSource.getRepository(Users).find({
            where: roles.map(role => ({ accounts: { role } })),
            relations: ["accounts"]
        });
    }

    private async notifyRoles(roles: UserRole[], data: { title: string, content: string, quotationId: string, link?: string, relatedEntityId?: string, relatedEntityType?: string }) {
        const recipients = await this.getUsersByRoles(roles);
        for (const recipient of recipients) {
            await this.notificationService.createNotification({
                ...data,
                type: "QUOTATION_UPDATE",
                recipient,
                link: data.link || `/quotations/${data.quotationId}`,
                relatedEntityId: data.relatedEntityId || data.quotationId,
                relatedEntityType: data.relatedEntityType || "Quotations"
            });
        }
    }

    private async notifyManagement(data: { title: string, content: string, recipient?: string, quotationId: string, link?: string, relatedEntityId?: string, relatedEntityType?: string }) {
        await this.notifyRoles([UserRole.BOD, UserRole.ADMIN], data);
    }

    private async notifyUsers(
        recipients: Users | Users[],
        data: {
            title: string;
            content: string;
            type: string;
            link?: string;
            relatedEntityId?: string;
            relatedEntityType?: string;
        }
    ) {
        const users = Array.isArray(recipients) ? recipients : [recipients];

        for (const recipient of users) {
            await this.notificationService.createNotification({
            title: data.title,
            content: data.content,
            type: data.type,
            recipient,
            link: data.link,
            relatedEntityId: data.relatedEntityId,
            relatedEntityType: data.relatedEntityType,
            });
        }
    }

    private async notifyBod(data: { title: string, content: string, quotationId: string, link?: string, relatedEntityId?: string, relatedEntityType?: string }) {
        await this.notifyRoles([UserRole.BOD], data);
    }

    private async notifyOpportunityCreator(quotation: Quotations, description?: string) {
        const opportunity = quotation.opportunity;
        const creator = opportunity?.createdBy;
        if (!opportunity?.id || !creator?.id) return;

        const reason = description?.trim();
        await this.notificationService.createNotification({
            title: "Báo giá bị từ chối",
            content: `Báo giá lần ${quotation.version} của cơ hội ${opportunity.opportunityCode}-${opportunity.name} bị từ chối.${reason ? ` Lý do: ${reason}` : ""}`,
            type: "QUOTATION_REJECTED",
            recipient: creator,
            link: `/opportunities/${opportunity.id}`,
            relatedEntityId: opportunity.id,
            relatedEntityType: "Opportunities"
        });
    }

    async getAll() {
        return await this.quotationRepository.find({
            relations: ["opportunity", "details", "details.service"]
        });
    }

    async getOne(id: string) {
        const quotation = await this.quotationRepository.findOne({
            where: { id },
            relations: [
                "opportunity",
                "opportunity.contracts",
                "opportunity.createdBy",
                "opportunity.customer",
                "opportunity.referralPartner",
                "opportunity.quotations",
                "opportunity.services",
                "details.opportunityService",
                "details",
                "details.service"
            ]
        });
        if (!quotation) throw new Error("Không tìm thấy báo giá");
        return quotation;
    }

    async getByOpportunity(opportunityId: string) {
        return await this.quotationRepository.find({
            where: { opportunity: { id: opportunityId } },
            relations: ["details", "details.service"],
            order: { version: "DESC" }
        });
    }

    // 1. Create Quotation: Copy from Opportunity Service -> Quotation Details
    async create(data: { opportunityId: string, note?: string, details?: any[] }, userInfo?: { id: string, userId?: string }) {
        const { opportunityId, note, details } = data;

        const opportunity = await this.opportunityRepository.findOne({
            where: { id: opportunityId },
            relations: [
                "services",
                "services.service",
                "services.jobs",
                "services.jobs.job",
                "packages",
                "packages.services",
                "packages.services.service"
            ]
        });

        if (!opportunity) throw new Error("Không tìm thấy cơ hội kinh doanh");

        const incompleteAiJobs = (opportunity.services || []).flatMap(opportunityService => {
            if (!opportunityService.service?.isAI) return [];

            return (opportunityService.jobs || []).filter(job =>
                job.isQuotationItem &&
                !job.isBriefVideo &&
                Number(job.costAtSale || 0) <= 0
            );
        });

        if (incompleteAiJobs.length > 0) {
            const jobNames = Array.from(new Set(incompleteAiJobs.map(job => job.name))).join(", ");
            throw new Error(`Vui lòng điền đầy đủ giá vốn công việc AI trước khi tạo báo giá`);
        }

        // Determine version
        const count = await this.quotationRepository.count({
            where: { opportunity: { id: opportunityId } }
        });
        const version = count + 1;

        const quotation = this.quotationRepository.create({
            opportunity,
            version,
            note,
            status: QuotationStatus.DRAFT,
            totalAmount: 0,
            createdBy: userInfo?.userId ? { id: userInfo.userId } as Users : undefined
        });


        const savedQuotation = await this.quotationRepository.save(quotation);

        let total = 0;

        // If details are provided from frontend, use them. Otherwise, copy from Opportunity.
        if (details && Array.isArray(details)) {
            const serviceRepository = AppDataSource.getRepository(Services);
            for (const item of details) {
                const service = item.serviceId ? await serviceRepository.findOneBy({ id: item.serviceId }) : null;
                const opportunityService = item.opportunityServiceId
                    ? await this.opportunityServiceRepository.findOneBy({ id: item.opportunityServiceId })
                    : null;
                const detail = this.quotationDetailRepository.create({
                    quotation: savedQuotation,
                    service,
                    serviceId: item.serviceId,
                    opportunityService: opportunityService || undefined,
                    opportunityServiceId: item.opportunityServiceId,
                    quantity: item.quantity || 1,
                    sellingPrice: roundUnitSellingPrice(item.sellingPrice || 0),
                    costAtSale: item.costAtSale || 0,
                    budget: Number(item.budget ?? opportunityService?.budget ?? 0),
                    name: item.name || service?.name || 'Service Item',
                    packageQuantity: item.packageQuantity || 1,
                    packageName: item.packageName,
                    packageKey: item.packageKey,
                    servicePackageId: item.servicePackageId,
                    isPackageService: item.isPackageService || false
                });
                await this.quotationDetailRepository.save(detail);
                if (opportunityService) {
                    opportunityService.budget = Number(detail.budget || 0);
                    await this.opportunityServiceRepository.save(opportunityService);
                }
                total += Number(detail.sellingPrice) * detail.quantity;
            }
        } else {
            // FALLBACK: Copy standalone services from Opportunity
            const standaloneServices = opportunity.services?.filter(s => !s.opportunityPackageId) || [];
            for (const oppService of standaloneServices) {
                const detail = this.quotationDetailRepository.create({
                    quotation: savedQuotation,
                    service: oppService.service,
                    serviceId: oppService.service?.id,
                    opportunityService: oppService,
                    opportunityServiceId: oppService.id,
                    quantity: oppService.quantity,
                    sellingPrice: roundUnitSellingPrice(oppService.sellingPrice),
                    costAtSale: oppService.costAtSale,
                    budget: oppService.budget,
                    name: oppService.service?.name || 'Standalone Service',
                    packageQuantity: 1,
                    isPackageService: false
                });
                await this.quotationDetailRepository.save(detail);
                total += Number(detail.sellingPrice) * detail.quantity;
            }

            // FALLBACK: Copy packages from Opportunity
            if (opportunity.packages) {
                for (const oppPkg of opportunity.packages) {
                    if (oppPkg.services) {
                        for (const s of oppPkg.services) {
                            const detail = this.quotationDetailRepository.create({
                                quotation: savedQuotation,
                                service: s.service,
                                serviceId: s.service?.id,
                                opportunityService: s,
                                opportunityServiceId: s.id,
                                quantity: Number(s.quantity) * Number(oppPkg.quantity || 1),
                                sellingPrice: roundUnitSellingPrice(s.sellingPrice),
                                costAtSale: s.costAtSale,
                                budget: s.budget,
                                name: s.service?.name || 'Package Item',
                                packageQuantity: oppPkg.quantity || 1,
                                packageName: oppPkg.name,
                                packageKey: oppPkg.id,
                                servicePackageId: oppPkg.servicePackageId,
                                isPackageService: true
                            });
                            await this.quotationDetailRepository.save(detail);
                            total += Number(detail.sellingPrice) * detail.quantity;
                        }
                    }
                }
            }
        }

        Object.assign(savedQuotation, calculatePricingTotals(total), { totalAmount: total });

        // Update Opportunity Status to QUOTATION_DRAFTING if it's new
        if (opportunity.status === OpportunityStatus.PENDING_OPP_APPROVAL) {
            opportunity.status = OpportunityStatus.QUOTATION_DRAFTING;
            await this.opportunityRepository.save(opportunity);
            opportunityEmitter.emit(OPPORTUNITY_EVENTS.UPDATED, opportunity);
        }

        const saved = await this.quotationRepository.save(savedQuotation);

        // Notify BOD when a new quotation is created.
        await this.notifyBod({
            title: "Báo giá mới",
            content: `Báo giá mới được tạo - ${opportunity.name}`,
            quotationId: saved.id
        });

        quotationEmitter.emit(QUOTATION_EVENTS.CREATED, saved);

        return saved;
    }

    async createAddendumQuotation(data: { opportunityId: string, taskIds: string[], note?: string }, userInfo?: { id: string, userId?: string }) {
        const { opportunityId, taskIds, note } = data;

        const opportunity = await this.opportunityRepository.findOne({
            where: { id: opportunityId },
            relations: ["contracts"]
        });
        if (!opportunity) throw new Error("Không tìm thấy cơ hội kinh doanh");
        if (!opportunity.contracts || opportunity.contracts.length === 0) throw new Error("Dự án chưa có hợp đồng để tạo phụ lục");

        const tasks = await this.taskRepository.find({
            where: taskIds.map(id => ({ id, isExtra: true, pricingStatus: PricingStatus.BILLABLE })),
            relations: ["job", "job.services", "mappedService"]
        });

        if (tasks.length !== taskIds.length) {
            throw new Error("Một số công việc không hợp lệ hoặc chưa được BOD định giá phát sinh");
        }

        const count = await this.quotationRepository.count({
            where: { opportunity: { id: opportunityId } }
        });
        const version = count + 1;

        const quotation = this.quotationRepository.create({
            opportunity,
            version,
            note,
            status: QuotationStatus.DRAFT,
            type: QuotationType.ADDENDUM,
            totalAmount: 0,
            createdBy: userInfo?.userId ? { id: userInfo.userId } as Users : undefined
        });


        const savedQuotation = await this.quotationRepository.save(quotation);

        let total = 0;
        const serviceRepo = AppDataSource.getRepository(Services);

        for (const task of tasks) {
            // 1. Ưu tiên lấy mappedService do BOD chọn tay khi định giá
            let service = task.mappedService;

            // 2. Nếu không có, tìm Service có Job đầu ra khớp với Job của Task
            if (!service) {
                service = await serviceRepo.findOne({
                    where: {
                        serviceJobs: {
                            jobId: task.job.id,
                            isOutput: true
                        }
                    },
                    relations: ["serviceJobs"]
                });
            }

            // 3. Fallback cuối cùng: lấy Service đầu tiên mà Job này thuộc về
            if (!service) {
                // FALLBACK: If no service is found, we will quote based on the Job directly.
                const detail = this.quotationDetailRepository.create({
                    quotation: savedQuotation,
                    job: task.job,
                    quantity: 1,
                    sellingPrice: roundUnitSellingPrice(task.sellingPrice),
                    costAtSale: task.cost
                });
                await this.quotationDetailRepository.save(detail);
                total += Number(detail.sellingPrice);
                continue;
            }

            const detail = this.quotationDetailRepository.create({
                quotation: savedQuotation,
                service: service,
                quantity: 1,
                sellingPrice: roundUnitSellingPrice(task.sellingPrice),
                costAtSale: task.cost
            });
            await this.quotationDetailRepository.save(detail);
            total += Number(detail.sellingPrice);
        }

        Object.assign(savedQuotation, calculatePricingTotals(total), { totalAmount: total });
        savedQuotation.tasks = tasks; // Link tasks to quotation
        const saved = await this.quotationRepository.save(savedQuotation);

        // Notify BOD when a new addendum quotation is created.
        await this.notifyBod({
            title: "Báo giá phụ lục mới",
            content: `Báo giá phụ lục Ver ${saved.version} cho cơ hội ${opportunity.opportunityCode}-${opportunity.name} đã được tạo bởi ${userInfo?.userId || 'Hệ thống'}`,
            quotationId: saved.id
        });

        quotationEmitter.emit(QUOTATION_EVENTS.CREATED, saved);

        return saved;
    }

    // 2. Update Quotation Details (Price, Qty)
    async update(id: string, data: { status?: QuotationStatus, note?: string, details?: any[] }, userInfo?: { id: string, userId?: string }) {
        const quotation = await this.getOne(id);

        if (quotation.status === QuotationStatus.APPROVED) {
            throw new Error("Không thể chỉnh sửa báo giá đã được duyệt");
        }

        if (data.note !== undefined) quotation.note = data.note;
        if (data.status && data.status !== QuotationStatus.APPROVED) quotation.status = data.status;

        // If details provided, update them
        if (data.details && Array.isArray(data.details)) {
            let total = 0;

            // 1. Clear old details from database
            await this.quotationDetailRepository.delete({ quotation: { id: quotation.id } });

            // 2. Clear old details from memory object to avoid TypeORM sync issues
            quotation.details = [];

            const serviceRepository = AppDataSource.getRepository(Services);

            for (const item of data.details) {
                const service = await serviceRepository.findOneBy({ id: item.serviceId });
                if (!service) {
                    throw new Error(`Không tìm thấy dịch vụ với ID: ${item.serviceId}`);
                }
                const opportunityService = item.opportunityServiceId
                    ? await this.opportunityServiceRepository.findOneBy({ id: item.opportunityServiceId })
                    : null;

                const detail = this.quotationDetailRepository.create({
                    quotation,
                    service,
                    serviceId: item.serviceId,
                    opportunityService: opportunityService || undefined,
                    opportunityServiceId: item.opportunityServiceId,
                    quantity: item.quantity || 1,
                    sellingPrice: roundUnitSellingPrice(item.sellingPrice || 0),
                    costAtSale: item.costAtSale || 0,
                    budget: Number(item.budget ?? opportunityService?.budget ?? 0),
                    name: item.name || service.name,
                    packageQuantity: item.packageQuantity || 1,
                    packageName: item.packageName,
                    packageKey: item.packageKey,
                    servicePackageId: item.servicePackageId,
                    isPackageService: item.isPackageService || false
                });

                await this.quotationDetailRepository.save(detail);
                if (opportunityService) {
                    opportunityService.budget = Number(detail.budget || 0);
                    await this.opportunityServiceRepository.save(opportunityService);
                }
                total += Number(detail.sellingPrice) * detail.quantity;

                // Keep in memory for the final return
                quotation.details.push(detail);
            }
            Object.assign(quotation, calculatePricingTotals(total), { totalAmount: total });
        }

        const saved = await this.quotationRepository.save(quotation);

        // Notify management
        await this.notifyManagement({
            title: "Báo giá được cập nhật",
            content: `Báo giá đã được cập nhật- ${saved.opportunity?.name} .`,
            quotationId: saved.id
        });

        quotationEmitter.emit(QUOTATION_EVENTS.UPDATED, saved);

        return saved;
    }

    // 3. Approve Quotation: Sync BACK to Opportunity
    async approve(id: string, actor?: QuotationActor) {
        const quotation = await this.getOne(id);

        if (quotation.status === QuotationStatus.APPROVED) {
            throw new Error("Báo giá này đã được duyệt rồi");
        }

        // 3. IF ADDENDUM: Create Contract Addendum and SYNC
        if (quotation.type === QuotationType.ADDENDUM) {
            quotation.status = QuotationStatus.APPROVED;
            quotation.description = quotation.description;
            await this.quotationRepository.save(quotation);

            const contract = quotation.opportunity.contracts?.[0];
            if (!contract) throw new Error("Không tìm thấy hợp đồng để tạo phụ lục");

            const addendumRepo = AppDataSource.getRepository(ContractAddendums);
            const addendum = addendumRepo.create({
                name: quotation.note || `Phụ lục phát sinh - Ver ${quotation.version}`,
                contract: contract,
                ...calculatePricingTotals(quotation.totalAmount),
                cost: quotation.details.reduce((sum, d) => sum + Number(d.costAtSale), 0),
                status: AddendumStatus.DRAFT
            });

            await addendumRepo.save(addendum);

            // Activate tasks linked to this quotation
            const tasks = await this.taskRepository.find({
                where: { quotation: { id: quotation.id } }
            });

            for (const task of tasks) {
                task.status = TaskStatus.PENDING;
                task.pricingStatus = PricingStatus.BILLABLE;
                await this.taskRepository.save(task);
            }

            return { message: "Đã duyệt báo giá phụ lục và tạo Phụ lục hợp đồng nháp. Các công việc liên quan đã được kích hoạt.", quotation, addendum };
        }

        // 4. IF INITIAL: approve the opportunity and create contract from the approved quotation
        const opportunity = quotation.opportunity;

        if (!quotation.details?.length) {
            throw new Error("Báo giá chưa có dịch vụ, không thể duyệt và tạo hợp đồng");
        }

        const invalidDetails = quotation.details.filter(detail => !detail.service?.id && !detail.serviceId);
        if (invalidDetails.length > 0) {
            throw new Error("Một số dòng báo giá chưa liên kết dịch vụ, vui lòng kiểm tra lại báo giá trước khi duyệt");
        }

        quotation.status = QuotationStatus.APPROVED;
        quotation.description = quotation.description;
        await this.quotationRepository.save(quotation);

        const totalRevenue = quotation.details.reduce(
            (sum, detail) => sum + (roundUnitSellingPrice(detail.sellingPrice || 0) * (detail.quantity || 1)),
            0
        );

        // 4. Update Opportunity Totals & Status
        opportunity.expectedRevenue = totalRevenue;
        opportunity.status = OpportunityStatus.QUOTE_APPROVED;

        await this.opportunityRepository.save(opportunity);
        opportunityEmitter.emit(OPPORTUNITY_EVENTS.UPDATED, opportunity);

        if (!opportunity.createdBy?.id) {
            throw new Error("Không tìm thấy người tạo cơ hội để tạo hợp đồng");
        }

        const creatorUserInfo = {
            ...actor,
            userId: opportunity.createdBy.id
        } as QuotationActor;

        const contract = await this.contractService.create({
            opportunityId: opportunity.id,
            quotationId: quotation.id,
            quotationDetails: quotation.details,
            sellingPrice: quotation.totalAmount || totalRevenue,
            cost: quotation.details.reduce(
                (sum, detail) => sum + (Number(detail.costAtSale || 0) * (detail.quantity || 1)),
                0
            ),
            name: opportunity.name || `Hợp đồng ${opportunity.opportunityCode}`,
        }, creatorUserInfo);

        // Notify management
        await this.notifyManagement({
            title: "Báo giá đã duyệt",
            content: `Báo giá lần ${quotation.version} cho cơ hội ${opportunity.opportunityCode}-${opportunity.name} đã được duyệt và tạo hợp đồng.`,
            quotationId: quotation.id,
            recipient: `${opportunity?.createdBy}`,
            link: `/opportunities/${opportunity.id}`,
            relatedEntityId: opportunity.id,
            relatedEntityType: "Opportunities"
        });

        await this.notifyUsers(opportunity.createdBy, {
            title: "Báo giá đã duyệt",
            content: `Báo giá lần ${quotation.version} cho cơ hội ${opportunity.opportunityCode}-${opportunity.name} đã được duyệt và tạo hợp đồng.`,
            type: "QUOTATION_APPROVED",
            link: `/opportunities/${opportunity.id}`,
            relatedEntityId: opportunity.id,
            relatedEntityType: "Opportunities",
        });

        quotationEmitter.emit(QUOTATION_EVENTS.APPROVED, quotation);

        return {
            message: "Đã duyệt báo giá và tạo hợp đồng",
            quotation,
            contract,
            opportunityId: opportunity.id,
            contractId: contract.id
        };
    }

    // 4. Reject Quotation
    async reject(id: string, description?: string) {
        const quotation = await this.getOne(id);

        if (quotation.status === QuotationStatus.APPROVED) {
            throw new Error("Không thể từ chối báo giá đã được duyệt");
        }

        quotation.status = QuotationStatus.REJECTED;
        quotation.description = description;
        const saved = await this.quotationRepository.save(quotation);

        await this.notifyOpportunityCreator(saved, description);

        quotationEmitter.emit(QUOTATION_EVENTS.REJECTED, saved);

        return { message: "Đã từ chối báo giá", quotation: saved };
    }

    async delete(id: string) {
        const quotation = await this.getOne(id);
        if (quotation.status === QuotationStatus.APPROVED) {
            throw new Error("Không thể xóa báo giá đã duyệt");
        }
        await this.quotationRepository.remove(quotation);
        quotationEmitter.emit(QUOTATION_EVENTS.DELETED, { id });
        return { message: "Xóa báo giá thành công" };
    }
}
