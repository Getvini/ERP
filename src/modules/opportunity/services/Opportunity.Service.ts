import { AppDataSource } from "../../../data-source";
import { Opportunities, CustomerType, OpportunityStatus } from "../entities/Opportunity.entity";
import { Customers } from "../../customer/entities/Customer.entity";
import { OpportunityServices } from "../../opportunity-service/entities/OpportunityService.entity";
import { Services } from "../../service/entities/Service.entity";
import { ReferralPartners } from "../../referral-partner/entities/ReferralPartner.entity";
import { Users } from "../../user/entities/User.entity";
import { OpportunityPackages } from "../entities/OpportunityPackage.entity";
import { OpportunityRejections } from "../entities/OpportunityRejection.entity";
import { assertRejectedOpportunityEditable, stripProtectedOpportunityFields } from "../helpers/OpportunityResubmit.helper";
import { ServicePackages } from "../../service-package/entities/ServicePackage.entity";
import { Like, In, IsNull } from "typeorm";
import { SecurityService } from "../../../shared/services/Security.Service";
import { NotificationService } from "../../notification/services/Notification.Service";
import { UserRole } from "../../account/entities/Account.entity";
import { Not } from "typeorm";
import { validateLeadData } from "../../customer/validations/Customer.Validation";
import { RedisService } from "../../../shared/services/Redis.Service";
import { opportunityEmitter, OPPORTUNITY_EVENTS } from "../events/OpportunityEmitter";
import { OpportunityServiceJobs } from "../../opportunity-service/entities/OpportunityServiceJob.entity";
import { calculateRecommendedSellingPrice } from "../../../shared/helpers/Pricing.helper";
import { Tasks } from "../../task/entities/Task.entity";
import { TaskStatus } from "../../../shared/entities/Enums";

export class OpportunityService {
    private opportunityRepository = AppDataSource.getRepository(Opportunities);
    private customerRepository = AppDataSource.getRepository(Customers);
    private referralPartnerRepository = AppDataSource.getRepository(ReferralPartners);
    private userRepository = AppDataSource.getRepository(Users);
    private opportunityPackageRepository = AppDataSource.getRepository(OpportunityPackages);
    private opportunityRejectionRepository = AppDataSource.getRepository(OpportunityRejections);
    private opportunityServiceRepository = AppDataSource.getRepository(OpportunityServices);
    private opportunityServiceJobRepository = AppDataSource.getRepository(OpportunityServiceJobs);
    private taskRepository = AppDataSource.getRepository(Tasks);
    private serviceRepository = AppDataSource.getRepository(Services);
    private packageRepository = AppDataSource.getRepository(ServicePackages);
    private notificationService = new NotificationService();

    private async getBodUsers() {
        return await this.userRepository.find({
            where: { accounts: { role: UserRole.BOD } },
            relations: ["accounts"]
        });
    }

    private async notifyBodCustomerAdded(opportunity: Opportunities, sender?: Users) {
        const bodUsers = await this.getBodUsers();
        for (const user of bodUsers) {
            await this.notificationService.createNotification({
                title: "Cơ hội đã có khách hàng",
                content: `Cơ hội ${opportunity.name} đã có khách hàng`,
                type: "OPPORTUNITY_CUSTOMER_ADDED",
                recipient: user,
                sender,
                relatedEntityId: opportunity.id,
                relatedEntityType: "Opportunities",
                link: `/opportunities/${opportunity.id}`
            });
        }
    }

    private async checkTaxIdUniqueness(taxId: string, userInfo?: { companyId?: string }, excludeOpportunityId?: string) {
        if (!taxId) return;

        // 1. Check in Customers (taxId)
        const customerExists = await this.customerRepository.findOne({
            where: SecurityService.withTenant({ taxId }, userInfo)
        });

        if (customerExists) {
            throw new Error("Khách hàng này đã tồn tại trên hệ thống ");
        }

        // 2. Check in Opportunities (leadTaxId)
        const opportunityExists = await this.opportunityRepository.findOne({
            where: SecurityService.withTenant({
                leadTaxId: taxId,
                ...(excludeOpportunityId ? { id: Not(excludeOpportunityId) } : {})
            }, userInfo)
        });

        if (opportunityExists) {
            throw new Error("Mã số thuế này đã tồn tại trên hệ thống (Cơ hội)");
        }
    }

    async getAll(filters: any = {}, userInfo?: { id: string, role: string, userId?: string, companyId?: string }) {
        const page = parseInt(filters.page) || 1;
        const limit = parseInt(filters.limit) || 10;
        const sortBy = filters.sortBy || "createdAt";
        const sortDir = (filters.sortDir || "DESC").toUpperCase() as "ASC" | "DESC";
        const searchTerm = filters.search ? `%${filters.search}%` : null;

        // Apply RBAC filters
        let rbacWhere: any = {};
        if (userInfo) {
            try {
                rbacWhere = SecurityService.getOpportunityFilters(userInfo);
            } catch (error: any) {
                if (error.message === "FORBIDDEN_ACCESS") {
                    return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
                }
                throw error;
            }
        }

        // Start with common filters
        const commonWhere: any = {};

        if (filters.status && filters.status !== 'ALL') {
            commonWhere.status = filters.status;
        }

        if (filters.customerId) {
            commonWhere.customer = { id: filters.customerId };
        }

        const finalWhereConditions: any[] = [];

        // Helper to combine conditions
        const combineConditions = (base: any, additional: any) => {
            return { ...base, ...additional };
        };

        // If RBAC returns an array (OR conditions for RBAC)
        if (Array.isArray(rbacWhere)) {
            for (const rbacCond of rbacWhere) {
                const currentBase = combineConditions(commonWhere, rbacCond);
                if (searchTerm) {
                    const searchableFields = ["name", "leadName"];
                    const relationSearchFields = [
                        {
                            customer: {
                                ...currentBase.customer,
                                name: Like(searchTerm)
                            }
                        },
                        { opportunityCode: Like(searchTerm) } // Corrected to directly use Like on opportunityCode
                    ];

                    searchableFields.forEach(field => {
                        finalWhereConditions.push({ ...currentBase, [field]: Like(searchTerm) });
                    });
                    relationSearchFields.forEach(relSearch => {
                        finalWhereConditions.push({ ...currentBase, ...relSearch });
                    });
                } else {
                    finalWhereConditions.push(currentBase);
                }
            }
        } else { // RBAC returns a single object (AND conditions for RBAC)
            const currentBase = combineConditions(commonWhere, rbacWhere);
            if (searchTerm) {
                const searchableFields = ["name", "leadName"];
                const relationSearchFields = [
                    {
                        customer: {
                            ...currentBase.customer,
                            name: Like(searchTerm)
                        }
                    },
                    { opportunityCode: Like(searchTerm) } // Corrected
                ];

                searchableFields.forEach(field => {
                    finalWhereConditions.push({ ...currentBase, [field]: Like(searchTerm) });
                });
                relationSearchFields.forEach(relSearch => {
                    finalWhereConditions.push({ ...currentBase, ...relSearch });
                });
            } else {
                finalWhereConditions.push(currentBase);
            }
        }

        const filtersKey = JSON.stringify(filters);
        const userInfoKey = userInfo ? `role_${userInfo.role}:user_${userInfo.id}` : 'no_user';
        const cacheKey = `opportunities:${SecurityService.getTenantCachePart(userInfo)}:all:${userInfoKey}:${filtersKey}`;

        return await RedisService.fetchWithCache(cacheKey, 3600, async () => {
            const [items, total] = await this.opportunityRepository.findAndCount({
                where: finalWhereConditions.length > 1 ? finalWhereConditions : finalWhereConditions[0],
                relations: ["customer", "referralPartner", "createdBy"],
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
            rbacWhere = SecurityService.getOpportunityFilters(userInfo);
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
        const cacheKey = `opportunities:${SecurityService.getTenantCachePart(userInfo)}:detail:${id}${userInfoKey}`;

        const result = await RedisService.fetchWithCache(cacheKey, 3600, async () => {
            const opportunity = await this.opportunityRepository.findOne({
                where: rbacWhere,
                relations: [
                    "customer",
                    "referralPartner",
                    "services",
                    "services.service",
                    "services.jobs",
                    "services.jobs.job",
                    "services.jobs.tasks",
                    "packages",
                    "packages.services",
                    "packages.services.service",
                    "packages.services.jobs",
                    "packages.services.jobs.job",
                    "packages.services.jobs.tasks",
                    "quotations",
                    "contracts",
                    "createdBy", "createdBy.accounts",
                    "rejections", "rejections.rejectedBy"
                ],
                order: { rejections: { rejectedAt: "DESC" } }
            });
            return opportunity;
        });
        if (!result) {
            throw new Error("Không tìm thấy cơ hội kinh doanh hoặc bạn không có quyền xem");
        }
        return result;
    }

    private async generateOpportunityCode(): Promise<string> {
        const now = new Date();
        const year = now.getFullYear().toString().slice(-2);
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const prefix = `CH-${year}-${month}`;

        // Find the count of opportunities created in this year and month
        const count = await this.opportunityRepository.count({
            where: {
                opportunityCode: Like(`${prefix}%`)
            }
        });

        const sequence = (count + 1).toString().padStart(3, '0');
        return `${prefix}-${sequence}`;
    }

    async create(data: any = {}, userInfo?: { id: string, role: string, userId?: string, companyId?: string }) {
        const {
            customerId,
            referralPartnerId,
            customerType,
            // Lead fields
            leadName,
            leadPhone,
            leadEmail,
            leadAddress,
            leadTaxId,
            services,
            packages,
            ...opportunityData
        } = data;

        validateLeadData(data);

        if (leadTaxId) {
            await this.checkTaxIdUniqueness(leadTaxId, userInfo);
        }

        // Auto-generate code if not provided
        if (!opportunityData.opportunityCode) {
            opportunityData.opportunityCode = await this.generateOpportunityCode();
        } else {
            // Check if opportunity code already exists
            const existing = await this.opportunityRepository.findOne({
                where: SecurityService.withTenant({ opportunityCode: opportunityData.opportunityCode }, userInfo)
            });
            if (existing) {
                throw new Error("Mã cơ hội đã tồn tại");
            }
        }

        const opportunity = this.opportunityRepository.create(SecurityService.withTenant({
            ...opportunityData,
            customerType: customerType || CustomerType.DIRECT,
            leadName,
            leadPhone,
            leadEmail,
            leadAddress,
            leadTaxId
        }, userInfo) as any) as unknown as Opportunities;

        // Handle Customer Logic
        if (customerId) {
            const customer = await this.customerRepository.findOne({ where: SecurityService.withTenant({ id: customerId }, userInfo) });
            if (!customer) {
                throw new Error("Không tìm thấy khách hàng");
            }
            opportunity.customer = customer;
            // Clear lead info if customer is selected (optional, but cleaner)
            opportunity.leadName = null;
            opportunity.leadPhone = null;
            opportunity.leadEmail = null;
            opportunity.leadAddress = null;
            opportunity.leadTaxId = null;
        }

        // Handle Referral Logic
        const pId = referralPartnerId || null;
        if (customerType === CustomerType.REFERRAL && pId) {
            const partner = await this.referralPartnerRepository.findOne({ where: SecurityService.withTenant({ id: pId }, userInfo) });
            if (!partner) {
                throw new Error("Không tìm thấy đối tác giới thiệu");
            }
            opportunity.referralPartner = partner;
        }

        // Handle CreatedBy Logic
        if (userInfo?.userId) {
            const user = await this.userRepository.findOne({
                where: { id: userInfo.userId },
                relations: ["accounts"]
            });
            if (user) {
                opportunity.createdBy = user;
                const role = userInfo.role;
                // Auto-skip approval for BOD/ADMIN
                if (role === "BOD" || role === "ADMIN") {
                    opportunity.status = OpportunityStatus.QUOTATION_DRAFTING;
                }
            }
        }

        await this.validateVideoBriefs(services, packages);
        const savedOpportunity = await this.opportunityRepository.save(opportunity);

        // Handle service and package selection
        await this.syncServicesAndPackages(savedOpportunity, services, packages);

        // --- Notifications ---
        if (opportunity.createdBy) {
            const creatorRole = userInfo?.role;
            // Notify BOD and ADMIN if creator is NOT one of them
            if (creatorRole !== UserRole.BOD && creatorRole !== UserRole.ADMIN) {
                const managementUsers = await this.userRepository.find({
                    where: { accounts: { role: In([UserRole.BOD, UserRole.ADMIN]), ...(userInfo?.companyId ? { companyId: userInfo.companyId } : {}) } },
                    relations: ["accounts"]
                });

                for (const user of managementUsers) {
                    await this.notificationService.createNotification({
                        title: "Cơ hội mới",
                        content: `Cơ hội (${savedOpportunity.opportunityCode})-${savedOpportunity.name}  đã được tạo bởi ${opportunity.createdBy.fullName}.`,
                        type: "OPPORTUNITY_CREATED",
                        recipient: user,
                        sender: opportunity.createdBy,
                        relatedEntityId: savedOpportunity.id,
                        relatedEntityType: "Opportunities",
                        link: `/opportunities/${savedOpportunity.id}`
                    });
                }
            }
        }

        // Invalidate list caches
        await RedisService.deleteCache('opportunities:all*');

        const freshData = await this.getOne(savedOpportunity.id);
        opportunityEmitter.emit(OPPORTUNITY_EVENTS.CREATED, freshData);

        return freshData;
    }

    async update(id: string, data: any = {}, userInfo?: { id: string, role: string, userId?: string, companyId?: string }) {
        const {
            customerId,
            referralPartnerId,
            customerType,
            source,
            // Lead fields
            leadName,
            leadPhone,
            leadEmail,
            leadAddress,
            leadTaxId,
            services,
            packages,
            ...rest
        } = data;

        validateLeadData(data);

        // Prepare the updated object
        const updateObj: any = { id };

        // 1. Manually update simple fields
        if (leadName !== undefined) updateObj.leadName = leadName;
        if (leadPhone !== undefined) updateObj.leadPhone = leadPhone;
        if (leadEmail !== undefined) updateObj.leadEmail = leadEmail;
        if (leadAddress !== undefined) updateObj.leadAddress = leadAddress;
        if (leadTaxId !== undefined) {
            if (leadTaxId) {
                await this.checkTaxIdUniqueness(leadTaxId, userInfo, id);
            }
            updateObj.leadTaxId = leadTaxId;
        }

        if (customerType) updateObj.customerType = customerType;

        // Apply remaining simple fields
        const allowedFields = ['name', 'description', 'field', 'expectedRevenue', 'budget', 'startDate', 'endDate', 'priority', 'successChance', 'region', 'durationMonths', 'partnerCommissionRate', 'expectedPartnerCommission', 'attachments'];
        for (const key of allowedFields) {
            if (rest[key] !== undefined) {
                updateObj[key] = rest[key];
            }
        }

        // 2. Handle Customer relationship
        if (customerId) {
            const customer = await this.customerRepository.findOne({ where: SecurityService.withTenant({ id: customerId }, userInfo) });
            if (!customer) throw new Error("Không tìm thấy khách hàng");
            updateObj.customer = customer;
            // Clear lead fields when linking a customer
            updateObj.leadName = null;
            updateObj.leadPhone = null;
            updateObj.leadEmail = null;
            updateObj.leadAddress = null;
            updateObj.leadTaxId = null;
        } else if (customerId === null || customerId === "") {
            updateObj.customer = null;
        }

        // 3. Handle Referral relationship
        const pId = referralPartnerId !== undefined ? referralPartnerId : undefined;
        if (pId) {
            const partner = await this.referralPartnerRepository.findOne({ where: SecurityService.withTenant({ id: pId }, userInfo) });
            if (!partner) throw new Error("Không tìm thấy đối tác giới thiệu");
            updateObj.referralPartner = partner;
            if (updateObj.customerType !== CustomerType.REFERRAL) {
                updateObj.customerType = CustomerType.REFERRAL;
            }
        } else if (pId === null || pId === "" || (customerType === CustomerType.DIRECT)) {
            updateObj.referralPartner = null;
        }

        if ((services && Array.isArray(services)) || (packages && Array.isArray(packages))) {
            await this.validateVideoBriefs(services, packages);
        }

        // 4. Save main entity using the update object
        const savedOpportunity = await this.opportunityRepository.save(updateObj);

        // 5. Update services and packages if provided
        if ((services && Array.isArray(services)) || (packages && Array.isArray(packages))) {
            const fullEntity = await this.opportunityRepository.findOne({ where: SecurityService.withTenant({ id }, userInfo) });
            if (fullEntity) {
                await this.syncServicesAndPackages(fullEntity, services, packages);
            }
        }

        // 6. Invalidate caches
        await RedisService.deleteCache('opportunities:all*');
        await RedisService.deleteCache(`opportunities:detail:${id}*`);

        // 7. Return FRESH data from DB (bypassing the getOne cache)
        const freshData = await this.opportunityRepository.findOne({
            where: SecurityService.withTenant({ id }, userInfo),
            relations: [
                "customer",
                "referralPartner",
                "services",
                "services.service",
                "services.jobs",
                "services.jobs.job",
                "packages",
                "packages.services",
                "packages.services.service",
                "packages.services.jobs",
                "packages.services.jobs.job",
                "quotations",
                "contracts",
                "createdBy", "createdBy.accounts"
            ]
        });

        if (freshData) {
            opportunityEmitter.emit(OPPORTUNITY_EVENTS.UPDATED, freshData);
        }

        return freshData;
    }

    async addCustomer(id: string, data: any = {}, userInfo?: { id: string, role: string, userId?: string, companyId?: string }) {
        const { customerId, referralPartnerId, customerType } = data;
        if (!customerId) {
            throw new Error("Vui lòng chọn khách hàng");
        }

        const opportunity = await this.opportunityRepository.findOne({
            where: SecurityService.withTenant({ id }, userInfo),
            relations: ["customer", "createdBy"]
        });
        if (!opportunity) {
            throw new Error("Không tìm thấy cơ hội kinh doanh");
        }

        const customer = await this.customerRepository.findOne({
            where: SecurityService.withTenant({ id: customerId }, userInfo)
        });
        if (!customer) {
            throw new Error("Không tìm thấy khách hàng");
        }

        const shouldNotifyBod = opportunity.customer?.id !== customer.id;

        opportunity.customer = customer;
        if (customerType) {
            opportunity.customerType = customerType;
        }
        opportunity.leadName = null;
        opportunity.leadPhone = null;
        opportunity.leadEmail = null;
        opportunity.leadAddress = null;
        opportunity.leadTaxId = null;

        if (referralPartnerId) {
            const partner = await this.referralPartnerRepository.findOne({
                where: SecurityService.withTenant({ id: referralPartnerId }, userInfo)
            });
            if (!partner) throw new Error("Không tìm thấy đối tác giới thiệu");
            opportunity.referralPartner = partner;
            opportunity.customerType = CustomerType.REFERRAL;
        } else if (customerType === CustomerType.DIRECT) {
            opportunity.referralPartner = null;
        }

        await this.opportunityRepository.save(opportunity);

        await RedisService.deleteCache('opportunities:all*');
        await RedisService.deleteCache(`opportunities:detail:${id}*`);

        const freshData = await this.opportunityRepository.findOne({
            where: SecurityService.withTenant({ id }, userInfo),
            relations: [
                "customer",
                "referralPartner",
                "services",
                "services.service",
                "services.jobs",
                "services.jobs.job",
                "packages",
                "packages.services",
                "packages.services.service",
                "packages.services.jobs",
                "packages.services.jobs.job",
                "quotations",
                "contracts",
                "createdBy", "createdBy.accounts"
            ]
        });

        if (freshData) {
            opportunityEmitter.emit(OPPORTUNITY_EVENTS.UPDATED, freshData);

            if (shouldNotifyBod) {
                const sender = userInfo?.userId
                    ? await this.userRepository.findOne({ where: { id: userInfo.userId } }) || undefined
                    : undefined;
                await this.notifyBodCustomerAdded(freshData, sender);
            }
        }

        return freshData;
    }

    async delete(id: string) {
        const opportunity = await this.getOne(id);
        await this.opportunityRepository.remove(opportunity);

        // Invalidate list and detail caches
        await RedisService.deleteCache('opportunities:all*');
        await RedisService.deleteCache(`opportunities:detail:${id}*`);

        opportunityEmitter.emit(OPPORTUNITY_EVENTS.DELETED, { id });

        return { message: "Xóa cơ hội kinh doanh thành công" };
    }


    async approve(id: string) {
        const opportunity = await this.getOne(id);

        if (opportunity.status !== OpportunityStatus.PENDING_OPP_APPROVAL) {
            throw new Error("Chỉ có thể duyệt cơ hội đang ở trạng thái chờ duyệt");
        }

        opportunity.status = OpportunityStatus.QUOTATION_DRAFTING;
        const result = await this.opportunityRepository.save(opportunity);

        // Notify the employee who created the opportunity.
        const doc = await this.getOne(id);
        if (doc.createdBy) {
            await this.notificationService.createNotification({
                title: "Cơ hội đã được duyệt",
                content: `Cơ hội "${doc.name}" (${doc.opportunityCode}) của bạn đã được duyệt.`,
                type: "OPPORTUNITY_APPROVED",
                recipient: doc.createdBy,
                relatedEntityId: doc.id,
                relatedEntityType: "Opportunities",
                link: `/opportunities/${doc.id}`
            });
        }

        const pendingVideoDemoTasks = await this.taskRepository.find({
            where: {
                opportunityId: doc.id,
                assigneeId: IsNull(),
                opportunityServiceJob: { isBriefVideo: true }
            },
            relations: ["opportunityServiceJob"]
        });
        await this.notifyProjectManagersAboutVideoDemoTasks(doc, pendingVideoDemoTasks);

        // Invalidate list and detail caches
        await RedisService.deleteCache('opportunities:all*');
        await RedisService.deleteCache(`opportunities:detail:${id}*`);

        opportunityEmitter.emit(OPPORTUNITY_EVENTS.APPROVED, doc);

        return { message: "Duyệt cơ hội thành công", opportunity: result };
    }

    async reject(id: string, reason: string, userInfo?: { id: string, role: string, userId?: string, companyId?: string }) {
        const rejectionReason = reason?.trim();

        if (!rejectionReason) {
            throw new Error("Vui lòng nhập lý do không duyệt");
        }

        const opportunity = await this.opportunityRepository.findOne({
            where: SecurityService.withTenant({ id }, userInfo),
            relations: ["createdBy"]
        });
        if (!opportunity) {
            throw new Error("Không tìm thấy cơ hội kinh doanh");
        }

        if (opportunity.status !== OpportunityStatus.PENDING_OPP_APPROVAL) {
            throw new Error("Chỉ có thể không duyệt cơ hội đang ở trạng thái chờ duyệt");
        }

        opportunity.status = OpportunityStatus.OPP_REJECTED;
        opportunity.rejectionReason = rejectionReason;
        const result = await this.opportunityRepository.save(opportunity);

        await this.opportunityRejectionRepository.save(this.opportunityRejectionRepository.create({
            opportunityId: opportunity.id,
            reason: rejectionReason,
            rejectedById: userInfo?.userId || null,
            rejectedAt: new Date(),
            resubmittedAt: null,
            ...SecurityService.getTenantWhere()
        } as any));

        if (opportunity.createdBy) {
            const sender = userInfo?.userId
                ? await this.userRepository.findOne({ where: { id: userInfo.userId } }) || undefined
                : undefined;
            await this.notificationService.createNotification({
                title: "Cơ hội không được duyệt",
                content: `Cơ hội "${opportunity.name}" (${opportunity.opportunityCode}) không được duyệt. Lý do: ${rejectionReason}`,
                type: "OPPORTUNITY_REJECTED",
                recipient: opportunity.createdBy,
                sender,
                relatedEntityId: opportunity.id,
                relatedEntityType: "Opportunities",
                link: `/opportunities/${opportunity.id}`
            });
        } else {
            console.warn(`[OpportunityService] Opportunity ${opportunity.opportunityCode} has no creator, rejection notification skipped`);
        }

        await RedisService.deleteCache('opportunities:all*');
        await RedisService.deleteCache(`opportunities:detail:${id}*`);

        opportunityEmitter.emit(OPPORTUNITY_EVENTS.REJECTED, result);

        return { message: "Không duyệt cơ hội thành công", opportunity: result };
    }

    private async findRejectedOpportunityForEdit(id: string, userInfo?: { id: string, role: string, userId?: string, companyId?: string }) {
        const opportunity = await this.opportunityRepository.findOne({
            where: SecurityService.withTenant({ id }, userInfo),
            relations: ["createdBy", "customer"]
        });
        if (!opportunity) {
            throw new Error("Không tìm thấy cơ hội kinh doanh");
        }
        assertRejectedOpportunityEditable(opportunity, userInfo);
        return opportunity;
    }

    async saveDraft(id: string, data: any = {}, userInfo?: { id: string, role: string, userId?: string, companyId?: string }) {
        await this.findRejectedOpportunityForEdit(id, userInfo);
        return await this.update(id, stripProtectedOpportunityFields(data), userInfo);
    }

    async resubmit(id: string, userInfo?: { id: string, role: string, userId?: string, companyId?: string }) {
        const opportunity = await this.findRejectedOpportunityForEdit(id, userInfo);

        if (!opportunity.customer && !opportunity.leadName) {
            throw new Error("Vui lòng bổ sung thông tin khách hàng trước khi gửi lại");
        }

        const now = new Date();
        const pendingRejection = await this.opportunityRejectionRepository.findOne({
            where: SecurityService.withTenant({ opportunityId: id, resubmittedAt: IsNull() }),
            order: { rejectedAt: "DESC" }
        });

        if (pendingRejection) {
            pendingRejection.resubmittedAt = now;
            await this.opportunityRejectionRepository.save(pendingRejection);
        } else if (opportunity.rejectionReason) {
            await this.opportunityRejectionRepository.save(this.opportunityRejectionRepository.create({
                opportunityId: id,
                reason: opportunity.rejectionReason,
                rejectedById: null,
                rejectedAt: opportunity.updatedAt || now,
                resubmittedAt: now,
                ...SecurityService.getTenantWhere()
            } as any));
        }

        opportunity.status = OpportunityStatus.PENDING_OPP_APPROVAL;
        opportunity.rejectionReason = null as any;
        await this.opportunityRepository.save(opportunity);

        const managementUsers = await this.userRepository.find({
            where: { accounts: { role: In([UserRole.BOD, UserRole.ADMIN]), ...(userInfo?.companyId ? { companyId: userInfo.companyId } : {}) } },
            relations: ["accounts"]
        });
        const sender = opportunity.createdBy;
        for (const user of managementUsers) {
            if (sender && user.id === sender.id) continue;
            await this.notificationService.createNotification({
                title: "Cơ hội được gửi lại để duyệt",
                content: `Cơ hội (${opportunity.opportunityCode})-${opportunity.name} đã được chỉnh sửa và gửi lại để duyệt.`,
                type: "OPPORTUNITY_RESUBMITTED",
                recipient: user,
                sender,
                relatedEntityId: opportunity.id,
                relatedEntityType: "Opportunities",
                link: `/opportunities/${opportunity.id}`
            });
        }

        await RedisService.deleteCache('opportunities:all*');
        await RedisService.deleteCache(`opportunities:detail:${id}*`);

        const freshData = await this.getOne(id);
        opportunityEmitter.emit(OPPORTUNITY_EVENTS.RESUBMITTED, freshData);

        return { message: "Đã gửi lại cơ hội để duyệt", opportunity: freshData };
    }

    private async notifyProjectManagersAboutVideoDemoTasks(opportunity: Opportunities, tasks: Tasks[]) {
        if (tasks.length === 0) return;

        const projectManagers = await this.userRepository.find({
            where: { accounts: { role: UserRole.PM } },
            relations: ["accounts"]
        });

        for (const task of tasks) {
            for (const manager of projectManagers) {
                await this.notificationService.createNotification({
                    title: "Yêu cầu Video AI demo mới",
                    content: `Cơ hội ${opportunity.opportunityCode} có hạng mục ${task.name} cần phân công.`,
                    type: "TASK_ASSIGNED",
                    recipient: manager,
                    relatedEntityId: task.id,
                    relatedEntityType: "Task",
                    link: `/tasks/${task.id}`
                });
            }
        }
    }

    private async syncServicesAndPackages(opportunity: Opportunities, services: any[], packages: any[]) {
        const existingAiTasks = await this.taskRepository.find({
            where: { opportunityId: opportunity.id, opportunityServiceJobId: Not(IsNull()) }
        });
        const taskInProgress = existingAiTasks.some((task) => task.assigneeId || task.status !== TaskStatus.PENDING);
        if (taskInProgress) {
            throw new Error("Không thể thay đổi danh sách dịch vụ AI sau khi công việc đã được phân công hoặc bắt đầu");
        }
        if (existingAiTasks.length > 0) {
            await this.taskRepository.remove(existingAiTasks);
        }

        // Clear existing services and packages
        await this.opportunityServiceRepository.delete(SecurityService.withTenant({ opportunity: { id: opportunity.id } }));
        await this.opportunityPackageRepository.delete(SecurityService.withTenant({ opportunity: { id: opportunity.id } }));

        // Handle Packages
        if (packages && Array.isArray(packages)) {
            for (const pkgItem of packages) {
                const pkg = this.opportunityPackageRepository.create({
                    opportunity: opportunity,
                    servicePackageId: pkgItem.servicePackageId,
                    name: pkgItem.name,
                    description: pkgItem.description,
                    quantity: pkgItem.quantity || 1,
                    ...SecurityService.getTenantWhere()
                } as any) as any;
                const savedPkg = await this.opportunityPackageRepository.save(pkg);

                if (pkgItem.services && Array.isArray(pkgItem.services)) {
                    for (const s of pkgItem.services) {
                        // Ensure we use the correct ID property from the frontend payload
                        const serviceId = s.serviceId || s.id;
                        if (!serviceId) {
                            console.warn(`[OpportunityService] Missing serviceId for item in package ${savedPkg.name}`);
                            continue;
                        }

                        const service = await this.serviceRepository.findOne({
                            where: SecurityService.withTenant({ id: serviceId }),
                            relations: ["serviceJobs", "serviceJobs.job"]
                        });
                        if (!service) {
                            console.warn(`[OpportunityService] Service not found for ID: ${serviceId}`);
                            continue;
                        }

                        const oppService = this.opportunityServiceRepository.create({
                            opportunity: opportunity,
                            opportunityPackage: savedPkg,
                            service: service,
                            serviceId: service.id,
                            sellingPrice: s.sellingPrice || service.costPrice || 0,
                            costAtSale: service.costPrice || 0,
                            quantity: (s.quantity || 1) * (savedPkg.quantity || 1),
                            name: s.name || service.name,
                            packageName: savedPkg.name,
                            isPackageService: true,
                            ...SecurityService.getTenantWhere()
                        } as any) as any;
                        const savedOppService = await this.opportunityServiceRepository.save(oppService);
                        await this.createOpportunityServiceJobs(savedOppService, service, s.jobs);
                    }
                }
            }
        }

        // Handle Standalone Services
        if (services && Array.isArray(services)) {
            for (const item of services) {
                const serviceId = typeof item === 'string' ? item : (item.serviceId || item.id);
                const quantity = typeof item === 'object' ? (item.quantity || 1) : 1;
                const sellingPrice = typeof item === 'object' ? item.sellingPrice : undefined;

                const service = await this.serviceRepository.findOne({
                    where: SecurityService.withTenant({ id: serviceId }),
                    relations: ["serviceJobs", "serviceJobs.job"]
                });
                if (!service) {
                    throw new Error(`Không tìm thấy dịch vụ với ID: ${serviceId}.`);
                }

                const oppService = this.opportunityServiceRepository.create({
                    opportunity: opportunity,
                    service: service,
                    serviceId: service.id,
                    sellingPrice: sellingPrice || service.costPrice || 0,
                    costAtSale: service.costPrice || 0,
                    quantity: quantity,
                    name: (typeof item === 'object' ? item.name : null) || service.name,
                    isPackageService: false,
                    ...SecurityService.getTenantWhere()
                } as any) as any;
                const savedOppService = await this.opportunityServiceRepository.save(oppService);
                await this.createOpportunityServiceJobs(savedOppService, service, typeof item === "object" ? item.jobs : undefined);
            }
        }
    }

    private async validateVideoBriefs(services: any[] = [], packages: any[] = []) {
        const selections = [
            ...(Array.isArray(services) ? services.map((item) => ({
                serviceId: typeof item === "string" ? item : (item.serviceId || item.id),
                jobs: typeof item === "object" ? item.jobs : []
            })) : []),
            ...(Array.isArray(packages) ? packages.flatMap((pkg) => (pkg.services || []).map((item: any) => ({
                serviceId: item.serviceId || item.id,
                jobs: item.jobs || []
            }))) : [])
        ];

        for (const selection of selections) {
            const service = await this.serviceRepository.findOne({
                where: SecurityService.withTenant({ id: selection.serviceId }),
                relations: ["serviceJobs", "serviceJobs.job"]
            });
            if (!service) continue;
            const inputByJobId = new Map((selection.jobs || []).map((item: any) => [String(item.jobId), item]));
            for (const serviceJob of service.serviceJobs || []) {
                if (serviceJob.job?.isBriefVideo) {
                    const input: any = inputByJobId.get(String(serviceJob.job.id));
                    if (input?.included === true && !input?.briefVideo?.trim()) {
                        throw new Error(`Vui lòng nhập brief cho hạng mục ${serviceJob.job.name}`);
                    }
                }
            }
        }
    }

    private async createOpportunityServiceJobs(
        opportunityService: OpportunityServices,
        service: Services,
        inputJobs?: { jobId?: string; included?: boolean; briefVideo?: string }[]
    ) {
        const inputByJobId = new Map(
            (inputJobs || []).map((item) => [String(item.jobId), item])
        );

        const snapshots = (service.serviceJobs || []).filter((serviceJob) => {
            if (!serviceJob.job.isBriefVideo) return true;
            const input = inputByJobId.get(String(serviceJob.job.id));
            return input?.included === true;
        }).map((serviceJob) => {
            const job = serviceJob.job;
            const input = inputByJobId.get(String(job.id));
            const briefVideo = input?.briefVideo?.trim() || null;

            if (job.isBriefVideo && !briefVideo) {
                throw new Error(`Vui lòng nhập brief cho hạng mục ${job.name}`);
            }

            return this.opportunityServiceJobRepository.create({
                opportunityServiceId: opportunityService.id,
                opportunityService,
                serviceJobId: serviceJob.id,
                serviceJob,
                jobId: job.id,
                job,
                name: job.name,
                quantity: Number(serviceJob.quantity || 1),
                briefVideo,
                costAtSale: Number(job.costPrice || 0),
                isBriefVideo: Boolean(job.isBriefVideo),
                isQuotationItem: !job.isBriefVideo && job.isQuotationItem !== false,
                ...SecurityService.getTenantWhere()
            } as any) as unknown as OpportunityServiceJobs;
        });

        if (snapshots.length > 0) {
            const savedSnapshots = await this.opportunityServiceJobRepository.save(snapshots);
            for (const snapshot of savedSnapshots.filter((item) => item.isBriefVideo)) {
                const sequence = String(await this.taskRepository.count({
                    where: { opportunityId: opportunityService.opportunity.id }
                }) + 1).padStart(2, "0");
                const task = this.taskRepository.create({
                    code: `${opportunityService.opportunity.opportunityCode}-${snapshot.job.code || "VIDEO"}-${sequence}`,
                    name: snapshot.name,
                    nickname: snapshot.job.nickname,
                    opportunity: opportunityService.opportunity,
                    opportunityId: opportunityService.opportunity.id,
                    opportunityServiceJob: snapshot,
                    opportunityServiceJobId: snapshot.id,
                    job: snapshot.job,
                    description: snapshot.briefVideo,
                    status: TaskStatus.PENDING
                });
                const savedTask = await this.taskRepository.save(task);

                // BD-created opportunities remain pending until BOD/Admin approval.
                // Notify PMs only when the opportunity has already passed that gate.
                if (opportunityService.opportunity.status !== OpportunityStatus.PENDING_OPP_APPROVAL) {
                    await this.notifyProjectManagersAboutVideoDemoTasks(
                        opportunityService.opportunity,
                        [savedTask]
                    );
                }
            }
        }

        await this.recalculateOpportunityServicePrices(opportunityService.id);
    }

    private async recalculateOpportunityServicePrices(opportunityServiceId: string) {
        const jobs = (await this.opportunityServiceJobRepository.find({
            where: SecurityService.withTenant({ opportunityServiceId })
        })).filter((job) => job.isQuotationItem && !job.isBriefVideo);

        const costAtSale = jobs.reduce(
            (sum, job) => sum + Number(job.costAtSale || 0) * Number(job.quantity || 1),
            0
        );
        const sellingPrice = calculateRecommendedSellingPrice(costAtSale);

        await this.opportunityServiceRepository.update(
            SecurityService.withTenant({ id: opportunityServiceId }),
            { costAtSale, sellingPrice }
        );
    }
}
