import { AppDataSource } from "../../../data-source";
import { Customers } from "../entities/Customer.entity";
import { Opportunities } from "../../opportunity/entities/Opportunity.entity";
import { Users } from "../../user/entities/User.entity";
import { SecurityService } from "../../../shared/services/Security.Service";
import { Not, ILike, In } from "typeorm";
import { validateCustomerData } from "../validations/Customer.Validation";
import { RedisService } from "../../../shared/services/Redis.Service";
import { customerEmitter, CUSTOMER_EVENTS } from "../events/CustomerEmitter";

export class CustomerService {
    private customerRepository = AppDataSource.getRepository(Customers);
    private opportunityRepository = AppDataSource.getRepository(Opportunities);

    private async checkTaxIdUniqueness(taxId: string, userInfo?: { companyId?: string }, excludeCustomerId?: string) {
        if (!taxId) return;

        // 1. Check in Customers
        const customerExists = await this.customerRepository.findOne({
            where: SecurityService.withTenant({
                taxId,
                ...(excludeCustomerId ? { id: Not(excludeCustomerId) } : {})
            }, userInfo)
        });

        if (customerExists) {
            throw new Error("Khách hàng này đã tồn tại trên hệ thống");
        }

        // 2. Check in Opportunities (leadTaxId)
        const opportunityExists = await this.opportunityRepository.findOne({
            where: SecurityService.withTenant({ leadTaxId: taxId }, userInfo)
        });

        if (opportunityExists) {
            throw new Error("Mã số thuế này đã tồn tại trên hệ thống (Cơ hội)");
        }
    }

    async getAll(userInfo?: { id: string, role: string, userId?: string, companyId?: string }, filters: any = {}) {
        let rbacWhere: any = {};
        if (userInfo) {
            try {
                rbacWhere = SecurityService.getCustomerFilters(userInfo);
            } catch (error: any) {
                if (error.message === "FORBIDDEN_ACCESS") {
                    return [];
                }
                throw error;
            }
        }

        const baseWhere: any = {};
        if (filters.source && filters.source !== 'ALL') {
            const sourceList = Array.isArray(filters.source)
                ? filters.source
                : (typeof filters.source === 'string' && filters.source.includes(',')
                    ? filters.source.split(',').map((s: string) => s.trim()).filter(Boolean)
                    : null);

            if (sourceList && sourceList.length > 0) {
                baseWhere.source = In(sourceList);
            } else {
                baseWhere.source = filters.source;
            }
        }

        let where: any = [];
        const combineWithSearch = (cond: any) => {
            if (filters.search && String(filters.search).trim()) {
                const searchTerm = `%${String(filters.search).trim()}%`;
                return [
                    { ...baseWhere, ...cond, name: ILike(searchTerm) },
                    { ...baseWhere, ...cond, phone: ILike(searchTerm) },
                    { ...baseWhere, ...cond, email: ILike(searchTerm) },
                    { ...baseWhere, ...cond, taxId: ILike(searchTerm) },
                    { ...baseWhere, ...cond, address: ILike(searchTerm) },
                    { ...baseWhere, ...cond, referralPartner: { ...(cond?.referralPartner || {}), name: ILike(searchTerm) } }
                ];
            }
            return { ...baseWhere, ...cond };
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

        const filtersKey = JSON.stringify(filters || {});
        // We prefix with user role and id to avoid RBAC leaking across different caches
        const cacheKey = userInfo
            ? `customers:${SecurityService.getTenantCachePart(userInfo)}:all:role_${userInfo.role}:user_${userInfo.id}:${filtersKey}`
            : `customers:${SecurityService.getTenantCachePart()}:all:${filtersKey}`;

        return await RedisService.fetchWithCache(cacheKey, 3600, async () => {
            return await this.customerRepository.find({
                where: where.length > 1 ? where : (where[0] || {}),
                relations: ["referralPartner"],
                order: { createdAt: "DESC" }
            });
        });
    }

    async getOne(id: string, userInfo?: { id: string, role: string, userId?: string, companyId?: string }) {
        let rbacWhere: any = {};
        if (userInfo) {
            rbacWhere = SecurityService.getCustomerFilters(userInfo);
        }

        const cacheKey = userInfo ? `customers:${SecurityService.getTenantCachePart(userInfo)}:detail:${id}:role_${userInfo.role}:user_${userInfo.id}` : `customers:${SecurityService.getTenantCachePart()}:detail:${id}`;

        const customer = await RedisService.fetchWithCache(cacheKey, 3600, async () => {
            return await this.customerRepository.findOne({
                where: SecurityService.withTenant({ id, ...rbacWhere }, userInfo),
                relations: ["referralPartner", "contracts", "opportunities", "createdBy", "createdBy.accounts"]
            });
        });

        if (!customer) throw new Error("Không tìm thấy khách hàng hoặc bạn không có quyền xem");
        return customer;
    }

    async create(data: any, userInfo?: { id: string, role: string, userId?: string, companyId?: string }) {
        validateCustomerData(data);
        if (data.taxId) {
            await this.checkTaxIdUniqueness(data.taxId, userInfo);
        }

        // Handle phoneNumber from frontend
        if (!data.phone && data.phoneNumber) {
            data.phone = data.phoneNumber;
        }

        const customer = this.customerRepository.create(SecurityService.withTenant(data, userInfo) as Partial<Customers>);
        if (userInfo?.userId) {
            customer.createdBy = { id: userInfo.userId } as Users;
        }
        const savedCustomer = await this.customerRepository.save(customer);

        // Invalidate all customer list caches (all roles and users)
        await RedisService.deleteCache('customers:all*');

        customerEmitter.emit(CUSTOMER_EVENTS.CREATED, savedCustomer);

        return savedCustomer;
    }

    async update(id: string, data: any, userInfo?: { id: string, role: string, userId?: string, companyId?: string }) {
        validateCustomerData(data);
        if (data.taxId) {
            await this.checkTaxIdUniqueness(data.taxId, userInfo, id);
        }

        console.log(`[CustomerService] Updating customer ${id} with data:`, JSON.stringify(data, null, 2));

        // Handle phoneNumber from frontend
        if (!data.phone && data.phoneNumber) {
            data.phone = data.phoneNumber;
        }

        const customer = await this.getOne(id, userInfo);

        // Filter out empty string values to avoid overwriting existing data
        const updateData = Object.fromEntries(
            Object.entries(data).filter(([_, v]) => v !== '' && v !== undefined)
        );

        Object.assign(customer, updateData);
        const savedCustomer = await this.customerRepository.save(customer);

        // Invalidate all list caches and this specific customer's detail caches
        await RedisService.deleteCache('customers:all*');
        await RedisService.deleteCache(`customers:detail:${id}*`);

        customerEmitter.emit(CUSTOMER_EVENTS.UPDATED, savedCustomer);

        return savedCustomer;
    }

    async delete(id: string, userInfo?: { id: string, role: string, userId?: string, companyId?: string }) {
        const customer = await this.getOne(id, userInfo);
        await this.customerRepository.remove(customer);

        // Invalidate all list caches and this specific customer's detail caches
        await RedisService.deleteCache('customers:all*');
        await RedisService.deleteCache(`customers:detail:${id}*`);

        customerEmitter.emit(CUSTOMER_EVENTS.DELETED, { id });

        return { message: "Xóa khách hàng thành công" };
    }
}
