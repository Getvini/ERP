import { AppDataSource } from "../../../data-source";
import { Contracts } from "../entities/Contract.entity";
import { Customers, CustomerSource } from "../../customer/entities/Customer.entity";
import { Opportunities, CustomerType, OpportunityStatus } from "../../opportunity/entities/Opportunity.entity";
import { ReferralPartners } from "../../referral-partner/entities/ReferralPartner.entity";
import { Like, ILike, In } from "typeorm";
import { PaymentMilestones, MilestoneStatus } from "../../payment-milestone/entities/PaymentMilestone.entity";
import { ContractStatus } from "../entities/Contract.entity";
import { OpportunityServices } from "../../opportunity-service/entities/OpportunityService.entity";
import { ContractServices } from "../entities/ContractService.entity";
import { Quotations, QuotationStatus } from "../../quotation/entities/Quotation.entity";
import { ProjectService } from "../../project/services/Project.Service";
import { DebtService } from "../../debt/services/Debt.Service";
import { NotificationService } from "../../notification/services/Notification.Service";
import { Users } from "../../user/entities/User.entity";
import { isProjectManagementRole, UserRole } from "../../account/entities/Account.entity";
import { RedisService } from "../../../shared/services/Redis.Service";
import { contractEmitter, CONTRACT_EVENTS } from "../events/ContractEmitter";
import { opportunityEmitter, OPPORTUNITY_EVENTS } from "../../opportunity/events/OpportunityEmitter";
import { SecurityService } from "../../../shared/services/Security.Service";
import { Services } from "../../service/entities/Service.entity";
import { ServicePackages } from "../../service-package/entities/ServicePackage.entity";
import { CustomerService } from "../../customer/services/Customer.Service";
import { MemberRole, memberHasRole } from "../../project/entities/TeamMember.entity";
import { ProjectStatus } from "../../project/entities/Project.entity";
import { normalizeNickname } from "../../../shared/helpers/TaskNickname.helper";
import { calculatePricingTotals, getContractCollectibleTotal, roundUnitSellingPrice } from "../../../shared/helpers/PricingTax.helper";

export class ContractService {
    private contractRepository = AppDataSource.getRepository(Contracts);
    private customerRepository = AppDataSource.getRepository(Customers);
    private opportunityRepository = AppDataSource.getRepository(Opportunities);
    private milestoneRepository = AppDataSource.getRepository(PaymentMilestones);
    private oppServiceRepository = AppDataSource.getRepository(OpportunityServices);
    private contractServiceRepository = AppDataSource.getRepository(ContractServices);
    private quotationRepository = AppDataSource.getRepository(Quotations);
    private userRepository = AppDataSource.getRepository(Users);
    private serviceRepository = AppDataSource.getRepository(Services);
    private packageRepository = AppDataSource.getRepository(ServicePackages);
    private customerService = new CustomerService();
    private projectService = new ProjectService();
    private debtService = new DebtService();
    private notificationService = new NotificationService();

    private httpError(message: string, statusCode: number) {
        const error: any = new Error(message);
        error.statusCode = statusCode;
        return error;
    }

    private canEditProjectContractService(project: any, actor?: { id?: string, role?: string, userId?: string }) {
        if (isProjectManagementRole(actor?.role)) return true;

        const actorUserId = actor?.userId || actor?.id;
        if (!actorUserId || !project?.team) return false;

        if (project.team.teamLead?.id === actorUserId) return true;

        return project.team.members?.some((member: any) =>
            member.user?.id === actorUserId &&
            [MemberRole.ACCOUNT, MemberRole.PROJECT_MANAGER].some(role => memberHasRole(member, role))
        ) || false;
    }

    private async getManagementUsers() {
        return await AppDataSource.getRepository(Users).find({
            where: [
                { accounts: { role: UserRole.BOD } },
                { accounts: { role: UserRole.ADMIN } }
            ],
            relations: ["accounts"]
        });
    }

    private async getUserFullName(userId?: string): Promise<string> {
        if (!userId) return "Hệ thống";
        const user = await this.userRepository.findOne({ where: { id: userId } });
        return user?.fullName || "Hệ thống";
    }

    private async notifyManagement(data: { title: string, content: string, contractId: string }) {
        const managers = await this.getManagementUsers();
        for (const manager of managers) {
            await this.notificationService.createNotification({
                ...data,
                type: "CONTRACT_UPDATE",
                recipient: manager,
                link: `/contracts/${data.contractId}`,
                relatedEntityId: data.contractId,
                relatedEntityType: "CONTRACT"
            });
        }
    }

    private async notifyContractCreator(
        contract: Contracts,
        data: { title: string, content: string, type: string },
        senderUserId?: string
    ) {
        if (!contract.createdBy?.id || contract.createdBy.id === senderUserId) return;

        await this.notificationService.createNotification({
            ...data,
            recipient: contract.createdBy,
            sender: senderUserId ? { id: senderUserId } as Users : undefined,
            link: `/contracts/${contract.id}`,
            relatedEntityId: contract.id,
            relatedEntityType: "CONTRACT"
        });
    }


    async getAll(filters: any = {}, userInfo?: { id: string, role: string, userId?: string, companyId?: string }) {
        const page = parseInt(filters.page) || 1;
        const limit = parseInt(filters.limit) || 10;
        const sortBy = filters.sortBy || "createdAt";
        const sortDir = (filters.sortDir || "DESC").toUpperCase() as "ASC" | "DESC";

        let rbacWhere: any = {};
        if (userInfo) {
            try {
                rbacWhere = SecurityService.getContractFilters(userInfo);
            } catch (error: any) {
                if (error.message === "FORBIDDEN_ACCESS") {
                    return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
                }
                throw error;
            }
        }

        const baseWhere: any = {};
        if (filters.status && filters.status !== 'ALL') {
            const statusList = Array.isArray(filters.status)
                ? filters.status
                : (typeof filters.status === 'string' && filters.status.includes(',')
                    ? filters.status.split(',').map((s: string) => s.trim()).filter(Boolean)
                    : null);

            if (statusList && statusList.length > 0) {
                baseWhere.status = In(statusList);
            } else {
                baseWhere.status = filters.status;
            }
        }

        if (filters.customerId) {
            baseWhere.customer = { id: filters.customerId };
        }

        // Combine search and RBAC
        let where: any = [];
        const combineWithSearch = (rbacCond: any) => {
            if (filters.search && String(filters.search).trim()) {
                const searchTerm = `%${String(filters.search).trim()}%`;
                return [
                    { ...baseWhere, ...rbacCond, contractCode: ILike(searchTerm) },
                    { ...baseWhere, ...rbacCond, name: ILike(searchTerm) },
                    {
                        ...baseWhere,
                        ...rbacCond,
                        customer: {
                            ...(rbacCond.customer || {}),
                            name: ILike(searchTerm)
                        }
                    }
                ];
            }
            return { ...baseWhere, ...rbacCond };
        };

        if (Array.isArray(rbacWhere)) {
            rbacWhere.forEach(cond => {
                const combined = combineWithSearch(cond);
                if (Array.isArray(combined)) {
                    where.push(...combined);
                } else {
                    where.push(combined);
                }
            });
        } else {
            const combined = combineWithSearch(rbacWhere);
            if (Array.isArray(combined)) {
                where.push(...combined);
            } else {
                where.push(combined);
            }
        }

        const filtersKey = JSON.stringify(filters);
        const userInfoKey = userInfo ? `role_${userInfo.role}:user_${userInfo.id}` : 'no_user';
        const cacheKey = `contracts:all:${userInfoKey}:${filtersKey}`;

        return await RedisService.fetchWithCache(cacheKey, 3600, async () => {
            const [items, total] = await this.contractRepository.findAndCount({
                where: where.length > 1 ? where : where[0],
                relations: ["customer", "opportunity", "opportunity.referralPartner", "debts", "addendums"],
                order: { [sortBy]: sortDir },
                skip: (page - 1) * limit,
                take: limit
            });

            return {
                data: items,
                meta: {
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit)
                }
            };
        });
    }

    async getOne(id: string, userInfo?: { id: string, role: string, userId?: string, companyId?: string }) {
        let rbacWhere: any = {};
        if (userInfo) {
            rbacWhere = SecurityService.getContractFilters(userInfo);
            // If rbacWhere is an array (OR conditions), we need to wrap the find with those conditions
            if (Array.isArray(rbacWhere)) {
                rbacWhere = rbacWhere.map(cond => ({ id, ...cond }));
            } else {
                rbacWhere = { id, ...rbacWhere };
            }
        } else {
            rbacWhere = { id };
        }

        const userInfoKey = userInfo ? `:role_${userInfo.role}:user_${userInfo.id}` : '';
        const cacheKey = `contracts:detail:${id}${userInfoKey}`;

        const contract = await RedisService.fetchWithCache(cacheKey, 3600, async () => {
            return await this.contractRepository.findOne({
                where: rbacWhere,
                relations: ["customer", "opportunity", "milestones", "services", "services.service", "debts", "addendums", "project"]
            });
        });
        if (!contract) {
            throw new Error("Không tìm thấy hợp đồng hoặc bạn không có quyền xem");
        }
        return contract;
    }

    async updateServiceNickname(
        id: string,
        nickname: string | null | undefined,
        userInfo?: { id?: string, role?: string, userId?: string, companyId?: string }
    ) {
        const contractService = await this.contractServiceRepository.findOne({
            where: { id },
            relations: [
                "contract",
                "contract.project",
                "contract.project.team",
                "contract.project.team.teamLead",
                "contract.project.team.members",
                "contract.project.team.members.user"
            ]
        });

        if (!contractService) throw this.httpError("Không tìm thấy hạng mục dịch vụ", 404);

        const project = contractService.contract?.project;
        if (project && [ProjectStatus.COMPLETED, ProjectStatus.CANCELLED, ProjectStatus.ON_HOLD].includes(project.status)) {
            throw this.httpError(`Dự án đang ở trạng thái "${project.status}", không thể chỉnh sửa hạng mục dịch vụ`, 409);
        }

        if (!this.canEditProjectContractService(project, userInfo)) {
            throw this.httpError("Bạn không có quyền thay đổi nickname của hạng mục dịch vụ này", 403);
        }
        if (nickname === undefined) throw this.httpError("Vui lòng cung cấp nickname", 400);
        if (nickname != null && typeof nickname !== "string") throw this.httpError("Nickname không hợp lệ", 400);

        const normalizedNickname = normalizeNickname(nickname);
        if (normalizedNickname && normalizedNickname.length > 120) {
            throw this.httpError("Nickname không được vượt quá 120 ký tự", 400);
        }

        contractService.nickname = normalizedNickname;
        const saved = await this.contractServiceRepository.save(contractService);

        await RedisService.deleteCache(`contracts:detail:${contractService.contract?.id}*`);
        await RedisService.deleteCache("contracts:all*");
        if (project?.id) await RedisService.deleteCache(`projects:detail:${project.id}*`);
        await RedisService.deleteCache("projects:all*");

        return saved;
    }

    private async generateContractCode(): Promise<string> {
        const now = new Date();
        const year = now.getFullYear().toString().slice(-2);
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const prefix = `SMGK-${year}-${month}`;

        const count = await this.contractRepository.count({
            where: {
                contractCode: Like(`${prefix}%`)
            }
        });

        const sequence = (count + 1).toString().padStart(3, '0');
        return `${prefix}-${sequence}`;
    }

    async create(data: any, userInfo?: { id: string, role: string, userId?: string, companyId?: string }) {
        const { opportunityId, quotationId, quotationDetails, ...contractData } = data;
        let approvedQuotationDetails = Array.isArray(quotationDetails) ? quotationDetails : [];

        // Auto-generate code
        if (!contractData.contractCode) {
            contractData.contractCode = await this.generateContractCode();
        } else {
            const existing = await this.contractRepository.findOne({
                where: SecurityService.withTenant({ contractCode: contractData.contractCode }, userInfo)
            });
            if (existing) {
                throw new Error("Mã hợp đồng đã tồn tại");
            }
        }

        let customer: Customers | null = null;
        let opportunity: Opportunities | null = null;

        if (opportunityId) {
            opportunity = await this.opportunityRepository.findOne({
                where: SecurityService.withTenant({ id: opportunityId }, userInfo),
                relations: ["customer", "referralPartner", "quotations", "services"]
            });

            if (!opportunity) {
                throw new Error("Không tìm thấy cơ hội kinh doanh");
            }

            // Check Status: Must be QUOTE_APPROVED
            if (opportunity.status !== OpportunityStatus.QUOTE_APPROVED) {
                throw new Error("Cơ hội đã được tạo hợp đồng");
            }

            // PROMOTION LOGIC: Lead -> Customer
            if (opportunity.customer) {
                customer = opportunity.customer;
            } else if (opportunity.leadName) {
                // Check if customer exists by phone or taxId to avoid dupes (basic check)
                let existingCustomer = null;
                if (opportunity.leadPhone) {
                    existingCustomer = await this.customerRepository.findOne({ where: SecurityService.withTenant({ phone: opportunity.leadPhone }, userInfo) });
                }

                if (!existingCustomer && opportunity.leadTaxId) {
                    existingCustomer = await this.customerRepository.findOne({ where: SecurityService.withTenant({ taxId: opportunity.leadTaxId }, userInfo) });
                }

                if (existingCustomer) {
                    customer = existingCustomer;
                    // Link to opportunity
                    opportunity.customer = customer;
                    await this.opportunityRepository.save(opportunity);
                } else {
                    // Create NEW Customer
                    const newCustomer = new Customers();
                    Object.assign(newCustomer, SecurityService.getTenantWhere(userInfo));
                    newCustomer.name = opportunity.leadName;
                    newCustomer.phone = opportunity.leadPhone || "";
                    newCustomer.email = opportunity.leadEmail || "";
                    newCustomer.address = opportunity.leadAddress || "";
                    newCustomer.taxId = opportunity.leadTaxId;

                    if (opportunity.customerType === CustomerType.REFERRAL && opportunity.referralPartner) {
                        newCustomer.source = CustomerSource.REFERRAL_PARTNER;
                        newCustomer.referralPartner = opportunity.referralPartner;
                    } else {
                        newCustomer.source = CustomerSource.INTERNAL;
                    }

                    if (userInfo?.userId) {
                        newCustomer.createdBy = { id: userInfo.userId } as Users;
                    } else {
                        console.warn("[ContractService] No userId in userInfo during customer promotion");
                    }
                    customer = await this.customerRepository.save(newCustomer);

                    // Update Opportunity to link to this new customer
                    opportunity.customer = customer;
                    await this.opportunityRepository.save(opportunity);
                }
            } else {
                throw new Error("Cơ hội chưa có thông tin khách hàng hoặc Lead");
            }

            if (approvedQuotationDetails.length === 0 && quotationId) {
                const quotation = await this.quotationRepository.findOne({
                    where: { id: quotationId },
                    relations: ["opportunity", "details", "details.service"]
                });

                if (!quotation) {
                    throw new Error("Không tìm thấy báo giá để tạo hợp đồng");
                }
                if (quotation.status !== QuotationStatus.APPROVED) {
                    throw new Error("Báo giá chưa được duyệt, không thể tạo hợp đồng");
                }
                if (quotation.opportunity?.id !== opportunity.id) {
                    throw new Error("Báo giá không thuộc cơ hội kinh doanh này");
                }

                approvedQuotationDetails = quotation.details || [];
            }

            if (quotationId && approvedQuotationDetails.length === 0) {
                throw new Error("Báo giá chưa có dịch vụ, không thể tạo hợp đồng");
            }

            const invalidQuotationDetails = approvedQuotationDetails.filter(detail => !detail.service?.id && !detail.serviceId);
            if (invalidQuotationDetails.length > 0) {
                throw new Error("Một số dòng báo giá chưa liên kết dịch vụ, không thể tạo hợp đồng");
            }
        } else if (data.customerData) {
            // Create customer on the fly
            customer = await this.customerService.create(data.customerData, userInfo);
        } else if (data.customerId) {
            // Direct contract without opportunity
            customer = await this.customerRepository.findOne({ where: SecurityService.withTenant({ id: data.customerId }, userInfo) });
            if (!customer) throw new Error("Không tìm thấy khách hàng");
        } else {
            throw new Error("Cần chọn Cơ hội kinh doanh hoặc Khách hàng");
        }

        // CALCULATE Selling Price and Cost if not provided or if from opportunity
        let finalSellingPrice = contractData.sellingPrice;
        let finalCost = contractData.cost;

        if (opportunity) {
            if (approvedQuotationDetails.length > 0) {
                const quotationSellingPrice = approvedQuotationDetails.reduce(
                    (sum, detail) => sum + (roundUnitSellingPrice(detail.sellingPrice || 0) * (detail.quantity || 1)),
                    0
                );
                const quotationCost = approvedQuotationDetails.reduce(
                    (sum, detail) => sum + (Number(detail.costAtSale || 0) * (detail.quantity || 1)),
                    0
                );
                if (finalSellingPrice === undefined || finalSellingPrice === null || finalSellingPrice === 0) {
                    finalSellingPrice = quotationSellingPrice;
                }
                if (finalCost === undefined || finalCost === null || finalCost === 0) {
                    finalCost = quotationCost;
                }
            } else {
                // Price Priority 1: Approved Quotation
                const approvedQuote = opportunity.quotations?.find(q => q.status === QuotationStatus.APPROVED);
                if (approvedQuote) {
                    finalSellingPrice = approvedQuote.totalAmount;
                } else {
                    // Price Priority 2: Sum of Opportunity Services
                    const serviceSum = opportunity.services?.reduce((sum, os) => sum + (roundUnitSellingPrice(os.sellingPrice) * (os.quantity || 1)), 0);
                    if (serviceSum > 0) {
                        finalSellingPrice = serviceSum;
                    }
                }

                // Cost calculation: Always sum of Opportunity Services
                const costSum = opportunity.services?.reduce((sum, os) => sum + (Number(os.costAtSale) * (os.quantity || 1)), 0);
                if (costSum > 0) {
                    finalCost = costSum;
                }
            }
        } else {
            // Direct contract: calculate based on services and packages arrays
            let computedSellingPrice = 0;
            let computedCost = 0;

            if (data.services && Array.isArray(data.services)) {
                for (const item of data.services) {
                    const serviceId = item.serviceId || item.id;
                    const service = await this.serviceRepository.findOne({ where: SecurityService.withTenant({ id: serviceId }, userInfo) });
                    if (service) {
                        const qty = item.quantity || 1;
                        const sellPrice = roundUnitSellingPrice(item.sellingPrice !== undefined ? item.sellingPrice : service.costPrice || 0);
                        computedSellingPrice += sellPrice * qty;
                        computedCost += Number(service.costPrice || 0) * qty;
                    }
                }
            }

            if (data.packages && Array.isArray(data.packages)) {
                for (const pkgItem of data.packages) {
                    const pkg = await this.packageRepository.findOne({
                        where: SecurityService.withTenant({ id: pkgItem.servicePackageId }, userInfo),
                        relations: ["items", "items.service"]
                    });
                    if (pkg) {
                        const pkgQty = pkgItem.quantity || 1;
                        for (const item of pkg.items) {
                            if (item.service) {
                                const qty = (item.defaultQuantity || 1) * pkgQty;
                                computedSellingPrice += Number(item.service.costPrice || 0) * qty;
                                computedCost += Number(item.service.costPrice || 0) * qty;
                            }
                        }
                    }
                }
            }

            if (finalSellingPrice === undefined || finalSellingPrice === null || finalSellingPrice === 0) {
                finalSellingPrice = computedSellingPrice;
            }
            if (finalCost === undefined || finalCost === null || finalCost === 0) {
                finalCost = computedCost;
            }
        }

        const contract = this.contractRepository.create(SecurityService.withTenant({
            ...contractData,
            ...calculatePricingTotals(finalSellingPrice || 0),
            cost: finalCost || 0,
            customer: customer,
            opportunity: opportunity,
            attachments: opportunity?.attachments || [], // Copy attachments
            description: opportunity?.description || contractData.description,
            createdBy: userInfo?.userId ? { id: userInfo.userId } as Users : undefined
        }, userInfo) as Partial<Contracts>);


        if (!contract.createdBy) {
            console.warn("[ContractService] contract.createdBy is undefined after set. userInfo.userId:", userInfo?.userId);
        }


        const savedContract = (await this.contractRepository.save(contract)) as unknown as Contracts;

        // MAP Opportunity Services to Contract Services
        if (opportunity) {
            if (approvedQuotationDetails.length > 0) {
                for (const detail of approvedQuotationDetails) {
                    const detailServiceId = detail.service?.id || detail.serviceId;
                    const detailService = detail.service || (detailServiceId
                        ? await this.serviceRepository.findOne({ where: SecurityService.withTenant({ id: detailServiceId }, userInfo) })
                        : null);
                    const opportunityService = opportunity.services?.find(item =>
                        item.serviceId === detailServiceId &&
                        item.isPackageService === Boolean(detail.isPackageService) &&
                        (!detail.isPackageService || item.packageName === detail.packageName)
                    );
                    const qty = Number(detail.quantity || 1);
                    for (let i = 0; i < qty; i++) {
                        const cs = this.contractServiceRepository.create({
                            contract: savedContract,
                            service: detailService,
                            serviceId: detailServiceId,
                            sellingPrice: roundUnitSellingPrice(detail.sellingPrice),
                            opportunityService,
                            name: detail.name || detailService?.name,
                            code: detailService?.code,
                            packageName: detail.packageName,
                            isPackageService: detail.isPackageService,
                            ...SecurityService.getTenantWhere(userInfo)
                        } as any);
                        await this.contractServiceRepository.save(cs);
                    }
                }
            } else {
                const oppServices = await this.oppServiceRepository.find({
                    where: SecurityService.withTenant({ opportunity: { id: opportunity.id } }, userInfo),
                    relations: ["service", "opportunity"]
                });

                for (const os of oppServices) {
                    const qty = os.quantity || 1;
                    for (let i = 0; i < qty; i++) {
                        const cs = this.contractServiceRepository.create({
                            contract: savedContract,
                            service: os.service,
                            serviceId: os.service?.id || os.serviceId,
                            sellingPrice: roundUnitSellingPrice(os.sellingPrice),
                            opportunityService: os,
                            name: os.name || os.service?.name,
                            code: os.service?.code,
                            packageName: os.packageName,
                            isPackageService: os.isPackageService,
                            ...SecurityService.getTenantWhere(userInfo)
                        } as any);
                        await this.contractServiceRepository.save(cs);
                    }
                }
            }
        } else {
            // Direct contract services mapping
            if (data.services && Array.isArray(data.services)) {
                for (const item of data.services) {
                    const serviceId = item.serviceId || item.id;
                    const service = await this.serviceRepository.findOne({ where: SecurityService.withTenant({ id: serviceId }, userInfo) });
                    if (service) {
                        const qty = item.quantity || 1;
                        const sellPrice = roundUnitSellingPrice(item.sellingPrice !== undefined ? item.sellingPrice : service.costPrice || 0);
                        for (let i = 0; i < qty; i++) {
                            const cs = this.contractServiceRepository.create({
                                contract: savedContract,
                                service: service,
                                serviceId: service.id,
                                sellingPrice: sellPrice,
                                name: service.name,
                                code: service.code,
                                isPackageService: false,
                                ...SecurityService.getTenantWhere(userInfo)
                            } as any);
                            await this.contractServiceRepository.save(cs);
                        }
                    }
                }
            }

            if (data.packages && Array.isArray(data.packages)) {
                for (const pkgItem of data.packages) {
                    const pkg = await this.packageRepository.findOne({
                        where: SecurityService.withTenant({ id: pkgItem.servicePackageId }, userInfo),
                        relations: ["items", "items.service"]
                    });
                    if (pkg) {
                        const pkgQty = pkgItem.quantity || 1;
                        for (const item of pkg.items) {
                            if (item.service) {
                                const qty = (item.defaultQuantity || 1) * pkgQty;
                                const customPrices = pkgItem.customPrices || {};
                                const customPrice = customPrices[item.service.id];
                                const sellPrice = roundUnitSellingPrice(customPrice !== undefined ? customPrice : item.service.costPrice || 0);

                                for (let i = 0; i < qty; i++) {
                                    const cs = this.contractServiceRepository.create({
                                        contract: savedContract,
                                        service: item.service,
                                        serviceId: item.service.id,
                                        sellingPrice: sellPrice,
                                        name: item.service.name,
                                        code: item.service.code,
                                        packageName: pkg.name,
                                        isPackageService: true,
                                        ...SecurityService.getTenantWhere(userInfo)
                                    } as any);
                                    await this.contractServiceRepository.save(cs);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Update Opportunity Status
        if (opportunity) {
            opportunity.status = OpportunityStatus.CONTRACT_CREATED;
            await this.opportunityRepository.save(opportunity);
            opportunityEmitter.emit(OPPORTUNITY_EVENTS.UPDATED, opportunity);
        }

        // Create default milestone (100%)
        const defaultMilestone = this.milestoneRepository.create({
            contract: savedContract,
            name: "Thanh toán đợt 1",
            percentage: 100,
            amount: getContractCollectibleTotal(savedContract),
            status: MilestoneStatus.PENDING,
            dueDate: new Date(new Date().setDate(new Date().getDate() + 30)), // Default 30 days
            ...SecurityService.getTenantWhere(userInfo)
        } as any);
        await this.milestoneRepository.save(defaultMilestone);

        // Invalidate contract caches before returning the freshly loaded detail
        await RedisService.deleteCache('contracts:all*');
        await RedisService.deleteCache(`contracts:detail:${savedContract.id}*`);

        const creatorName = await this.getUserFullName(userInfo?.userId);

        // Notify management
        await this.notifyManagement({
            title: "Hợp đồng mới",
            content: `Hợp đồng ${savedContract.contractCode}-${savedContract.name} đã được tạo bởi ${creatorName}`,
            contractId: savedContract.id
        });

        contractEmitter.emit(CONTRACT_EVENTS.CREATED, savedContract);

        return await this.getOne(savedContract.id, userInfo);
    }

    async uploadProposal(
        id: string,
        proposalUrl: string,
        quotationLink?: string,
        userInfo?: { id: string, userId?: string }
    ) {
        const contract = await this.getOne(id);
        contract.proposal_contract = proposalUrl.trim();
        contract.quotation_link = quotationLink?.trim() || null;
        contract.status = ContractStatus.PROPOSAL_UPLOADED;
        contract.rejectionReason = null; // Clear rejection reason on re-upload

        const savedResult = await this.contractRepository.save(contract);

        const uploaderName = await this.getUserFullName(userInfo?.userId);

        // Notify management
        await this.notifyManagement({
            title: "Hợp đồng được upload",
            content: `Hợp đồng ${savedResult.contractCode}-${savedResult.name} đã được upload bởi ${uploaderName}.`,
            contractId: savedResult.id
        });

        // Invalidate caches
        await RedisService.deleteCache(`contracts:detail:${id}*`);

        contractEmitter.emit(CONTRACT_EVENTS.UPDATED, savedResult);

        return savedResult;
    }

    async approveProposal(id: string, userInfo?: { id: string, userId?: string }) {
        const contract = await this.contractRepository.findOne({
            where: { id },
            relations: ["opportunity", "createdBy"]
        });
        if (!contract) throw new Error("Không tìm thấy hợp đồng");

        contract.status = ContractStatus.PROPOSAL_APPROVED;
        const savedContract = (await this.contractRepository.save(contract)) as unknown as Contracts;

        if (contract.opportunity) {
            contract.opportunity.status = OpportunityStatus.CONTRACT_APPROVED;
            await this.opportunityRepository.save(contract.opportunity);
            opportunityEmitter.emit(OPPORTUNITY_EVENTS.UPDATED, contract.opportunity);
        }

        // Auto Create Project (Draft)
        await this.projectService.createFromContract(savedContract, userInfo);

        // Notify management
        await this.notifyManagement({
            title: "Hợp đồng đã duyệt",
            content: `Hợp đồng ${savedContract.contractCode}-${savedContract.name} đã được duyệt. Dự án đã được khởi tạo.`,
            contractId: savedContract.id
        });

        await this.notifyContractCreator(savedContract, {
            title: "Hợp đồng đã được duyệt",
            content: `Hợp đồng ${savedContract.contractCode}-${savedContract.name} đã được BOD duyệt.`,
            type: "CONTRACT_APPROVED"
        }, userInfo?.userId);

        // Invalidate caches
        await RedisService.deleteCache(`contracts:detail:${id}*`);

        contractEmitter.emit(CONTRACT_EVENTS.UPDATED, savedContract);

        return savedContract;
    }


    async uploadSigned(id: string, fileData: any, userInfo?: { id: string, userId?: string }) {
        const contract = await this.contractRepository.findOne({
            where: { id },
            relations: ["project", "customer", "opportunity", "milestones", "services", "debts"]
        });
        if (!contract) throw this.httpError("Không tìm thấy hợp đồng", 404);

        if (contract.signed_contract) {
            throw this.httpError("Hợp đồng đã có bản ký, không thể upload lại", 409);
        }
        if (contract.status !== ContractStatus.PROPOSAL_APPROVED) {
            throw this.httpError("Hợp đồng cần được duyệt trước khi upload bản ký", 409);
        }

        contract.signed_contract = fileData.url;
        contract.status = ContractStatus.SIGNED;


        const savedContract = await this.contractRepository.save(contract);

        const uploaderName = await this.getUserFullName(userInfo?.userId);

        // Notify management
        await this.notifyManagement({
            title: "Hợp đồng đã upload bản ký",
            content: `Bản ký hợp đồng ${savedContract.contractCode}-${savedContract.name} đã được upload bởi ${uploaderName}.`,
            contractId: savedContract.id
        });

        // Invalidate caches
        await RedisService.deleteCache(`contracts:detail:${id}*`);

        contractEmitter.emit(CONTRACT_EVENTS.SIGNED, savedContract);

        return savedContract;
    }


    async addMilestone(contractId: string, data: { name: string, percentage: number, amount?: number, dueDate: Date }) {
        const contract = await this.getOne(contractId);

        // Validate percentage
        const currentMilestones = await this.milestoneRepository.find({ where: { contract: { id: contractId } } });
        const totalPercentage = currentMilestones.reduce((sum, m) => sum + Number(m.percentage), 0);

        if (totalPercentage + Number(data.percentage) > 100) {
            throw new Error(`Tổng phần trăm thanh toán không được vượt quá 100%. Hiện tại: ${totalPercentage}%`);
        }

        const amount = data.amount ?? (getContractCollectibleTotal(contract) * data.percentage / 100);

        const milestone = this.milestoneRepository.create({
            ...data,
            contract: contract,
            amount: amount,
            status: MilestoneStatus.PENDING
        });

        const savedMilestone = await this.milestoneRepository.save(milestone);

        // Invalidate detail cache (milestones are often included in detail)
        await RedisService.deleteCache(`contracts:detail:${contractId}*`);

        return savedMilestone;
    }

    async updateMilestone(id: string, data: Partial<PaymentMilestones>) {
        const milestone = await this.milestoneRepository.findOne({ where: { id }, relations: ["contract"] });
        if (!milestone) throw new Error("Không tìm thấy đợt thanh toán");

        if (data.percentage) {
            const currentMilestones = await this.milestoneRepository.find({ where: { contract: { id: milestone.contract.id } } });
            const otherMilestonesTotal = currentMilestones
                .filter(m => m.id !== id)
                .reduce((sum, m) => sum + Number(m.percentage), 0);

            if (otherMilestonesTotal + Number(data.percentage) > 100) {
                throw new Error(`Tổng phần trăm thanh toán không được vượt quá 100%. Hiện tại: ${otherMilestonesTotal}%`);
            }
            // Recalculate amount if percentage changes
            milestone.amount = getContractCollectibleTotal(milestone.contract) * Number(data.percentage) / 100;
        }

        Object.assign(milestone, data);
        const savedMilestone = await this.milestoneRepository.save(milestone);

        // Invalidate detail cache
        await RedisService.deleteCache(`contracts:detail:${milestone.contract.id}*`);

        return savedMilestone;
    }

    async deleteMilestone(id: string) {
        const milestone = await this.milestoneRepository.findOne({ where: { id } });
        if (!milestone) throw new Error("Không tìm thấy đợt thanh toán");
        const result = await this.milestoneRepository.remove(milestone);

        // Invalidate detail cache
        if (milestone.contract?.id) {
            await RedisService.deleteCache(`contracts:detail:${milestone.contract.id}*`);
        } else {
            // Fallback if relation not loaded
            await RedisService.deleteCache('contracts:detail*');
        }

        return result;
    }

    async delete(id: string) {
        const contract = await this.getOne(id);
        await this.contractRepository.remove(contract);

        // Invalidate caches
        await RedisService.deleteCache(`contracts:detail:${id}*`);

        contractEmitter.emit(CONTRACT_EVENTS.DELETED, { id });

        return { message: "Xóa hợp đồng thành công" };
    }

    async rejectProposal(id: string, reason: string, userInfo?: { id: string, userId: string }) {
        const contract = await this.contractRepository.findOne({
            where: { id },
            relations: ["opportunity", "opportunity.createdBy", "createdBy"]
        });
        if (!contract) throw new Error("Không tìm thấy hợp đồng");

        if (contract.status !== ContractStatus.PROPOSAL_UPLOADED) {
            throw new Error("Chỉ có thể từ chối hợp đồng đang ở trạng thái PROPOSAL_UPLOADED");
        }

        contract.status = ContractStatus.PROPOSAL_REJECTED;
        contract.rejectionReason = reason;

        const savedContract = await this.contractRepository.save(contract);

        // Invalidate caches
        await RedisService.deleteCache('contracts:all*');
        await RedisService.deleteCache(`contracts:detail:${id}*`);

        // Notify management
        await this.notifyManagement({
            title: "Hợp đồng bị từ chối",
            content: `Hợp đồng ${savedContract.contractCode}-${savedContract.name} bị từ chối. Lý do: ${reason}`,
            contractId: savedContract.id
        });

        await this.notifyContractCreator(savedContract, {
            title: "Hợp đồng bị từ chối",
            content: `Hợp đồng ${savedContract.contractCode}-${savedContract.name} đã bị BOD từ chối. Lý do: ${reason}`,
            type: "CONTRACT_REJECTED"
        }, userInfo?.userId);

        // Notify Opportunity Creator
        if (contract.opportunity?.createdBy && contract.opportunity.createdBy.id !== contract.createdBy?.id) {
            const sender = userInfo?.userId ? { id: userInfo.userId } as Users : undefined;
            await this.notificationService.createNotification({
                title: "Hợp đồng bị từ chối",
                content: `Hợp đồng ${contract.contractCode}-${contract.name} đã bị từ chối với lý do: ${reason}`,
                type: "CONTRACT_REJECTION",
                recipient: contract.opportunity.createdBy,
                sender: sender,
                relatedEntityId: contract.id,
                relatedEntityType: "CONTRACT",
                link: `/opportunities/${contract.opportunity.id}`
            });
        }

        contractEmitter.emit(CONTRACT_EVENTS.REJECTED, savedContract);

        return savedContract;
    }
}
