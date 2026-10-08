import { AppDataSource } from "../../../data-source";
import { Services } from "../entities/Service.entity";
import { Jobs } from "../../job/entities/Job.entity";
import { ServiceJob } from "../entities/ServiceJob.entity";
import { In, ILike, Raw } from "typeorm";
import { RedisService } from "../../../shared/services/Redis.Service";
import { SecurityService } from "../../../shared/services/Security.Service";

export class ServiceService {
    private serviceRepository = AppDataSource.getRepository(Services);

    private normalizeServicePayload(data: any = {}) {
        if (typeof data.code === "string") {
            data.code = data.code.trim();
        }
        if (typeof data.name === "string") {
            data.name = data.name.trim();
        }
        return data;
    }

    private generateCodeFromName(name: string) {
        const words = name
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/đ/g, "d")
            .replace(/Đ/g, "D")
            .match(/[a-zA-Z0-9]+/g);

        const code = words?.map((word) => word[0]).join("").toUpperCase();
        return code || "DV";
    }

    private async generateUniqueCodeFromName(name: string) {
        const baseCode = this.generateCodeFromName(name);
        let code = baseCode;
        let suffix = 2;

        while (await this.findByCode(code)) {
            code = `${baseCode}${suffix}`;
            suffix += 1;
        }

        return code;
    }

    private async findByCode(code: string) {
        return await this.serviceRepository.findOne({
            where: {
                ...SecurityService.withTenant({
                    code: Raw((alias) => `LOWER(TRIM(${alias})) = LOWER(TRIM(:code))`, { code })
                })
            }
        });
    }

    async getAll(filters: { name?: string, page?: number, limit?: number } = {}) {
        const page = Number(filters.page) || 1;
        const limit = Number(filters.limit) || 1000; // Use a large default if not specified
        const skip = (page - 1) * limit;

        const query: any = {
            relations: ["serviceJobs", "serviceJobs.job"],
            skip,
            take: limit
        };

        if (filters.name) {
            query.where = { name: ILike(`%${filters.name}%`) };
        }
        query.where = SecurityService.withTenant(query.where || {});

        const filtersKey = JSON.stringify(filters);
        const cacheKey = `services:${SecurityService.getTenantCachePart()}:all:${filtersKey}`;

        return await RedisService.fetchWithCache(cacheKey, 3600, async () => {
            const [items, total] = await this.serviceRepository.findAndCount(query);
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

    async getOne(id: string) {
        const cacheKey = `services:${SecurityService.getTenantCachePart()}:detail:${id}`;
        const service = await RedisService.fetchWithCache(cacheKey, 3600, async () => {
            return await this.serviceRepository.findOne({
                where: SecurityService.withTenant({ id }),
                relations: ["serviceJobs", "serviceJobs.job"]
            });
        });
        if (!service) throw new Error("Không tìm thấy dịch vụ");
        return service;
    }

    async recalculateCost(serviceId: string) {
        const service = await this.serviceRepository.findOne({
            where: SecurityService.withTenant({ id: serviceId }),
            relations: ["serviceJobs", "serviceJobs.job"]
        });
        if (!service) return;

        const jobsTotal = (service.serviceJobs || []).reduce((sum, sj) => {
            const cost = Number(sj.job?.costPrice || 0);
            const qty = Number(sj.quantity || 1);
            return sum + (cost * qty);
        }, 0);
        
        service.costPrice = jobsTotal;

        return await this.serviceRepository.save(service);
    }


    async create(data: any = {}) {
        const { jobIds, outputJobIds, ...serviceData } = data;
        this.normalizeServicePayload(serviceData);

        if (!serviceData.name) {
            throw new Error("Tên dịch vụ là bắt buộc");
        }
        serviceData.code = await this.generateUniqueCodeFromName(serviceData.name);

        const service = this.serviceRepository.create(SecurityService.withTenant(serviceData) as Partial<Services>);
        const savedService = (await this.serviceRepository.save(service)) as unknown as Services;

        // Invalidate list cache
        await RedisService.deleteCache('services:all*');

        if (jobIds && Array.isArray(jobIds)) {
            const sjRepo = AppDataSource.getRepository(ServiceJob);
            const serviceJobs = jobIds.map(jobId => sjRepo.create({
                serviceId: savedService.id,
                jobId,
                quantity: 1,
                isOutput: (outputJobIds || []).includes(jobId),
                ...SecurityService.getTenantWhere()
            } as any) as unknown as ServiceJob);
            await sjRepo.save(serviceJobs);
        }

        return await this.recalculateCost(savedService.id);
    }


    async update(id: string, data: any = {}) {
        const { jobConfigs, ...serviceData } = data; // jobConfigs: [{ jobId, quantity, isOutput }]
        this.normalizeServicePayload(serviceData);
        const service = await this.getOne(id);

        if (serviceData.code) {
            const existingService = await this.findByCode(serviceData.code);
            if (existingService && existingService.id !== id) throw new Error("Mã dịch vụ đã tồn tại");
        }

        Object.assign(service, serviceData);
        await this.serviceRepository.save(service);

        // Invalidate caches
        await RedisService.deleteCache('services:all*');
        await RedisService.deleteCache(`services:detail:${id}*`);

        if (jobConfigs && Array.isArray(jobConfigs)) {
            const sjRepo = AppDataSource.getRepository(ServiceJob);
            // Simple approach: clear and recreation or sync
            await sjRepo.delete(SecurityService.withTenant({ serviceId: id }));
            
            const newSjs = jobConfigs.map(config => sjRepo.create({
                serviceId: id,
                jobId: config.jobId,
                quantity: config.quantity || 1,
                isOutput: config.isOutput || false,
                ...SecurityService.getTenantWhere()
            } as any) as unknown as ServiceJob);
            await sjRepo.save(newSjs);
        }

        return await this.recalculateCost(id);
    }


    async delete(id: string) {
        const service = await this.getOne(id);
        await this.serviceRepository.remove(service);

        // Invalidate caches
        await RedisService.deleteCache('services:all*');
        await RedisService.deleteCache(`services:detail:${id}*`);

        return { message: "Xóa dịch vụ thành công" };
    }

    async bulkDelete(ids: string[]) {
        if (!ids || ids.length === 0) throw new Error("Danh sách ID không được để trống");
        
        await this.serviceRepository.delete(SecurityService.withTenant({ id: In(ids) }));

        // Invalidate caches
        await RedisService.deleteCache('services:all*');
        for (const id of ids) {
            await RedisService.deleteCache(`services:detail:${id}*`);
        }

        return { message: `Xóa thành công ${ids.length} dịch vụ` };
    }

    async addJob(serviceId: string, jobId: string) {
        const sjRepo = AppDataSource.getRepository(ServiceJob);
        const existing = await sjRepo.findOne({ where: SecurityService.withTenant({ serviceId, jobId }) });

        if (!existing) {
            const sj = sjRepo.create(SecurityService.withTenant({ serviceId, jobId, quantity: 1, isOutput: false }));
            await sjRepo.save(sj);
            await this.recalculateCost(serviceId);

            // Invalidate caches
            await RedisService.deleteCache('services:all*');
            await RedisService.deleteCache(`services:detail:${serviceId}*`);
        }

        return await this.getOne(serviceId);
    }

    async removeJob(serviceId: string, jobId: string) {
        const sjRepo = AppDataSource.getRepository(ServiceJob);
        await sjRepo.delete(SecurityService.withTenant({ serviceId, jobId }));
        await this.recalculateCost(serviceId);

        // Invalidate caches
        await RedisService.deleteCache('services:all*');
        await RedisService.deleteCache(`services:detail:${serviceId}*`);

        return await this.getOne(serviceId);
    }
}
