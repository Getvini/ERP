import { AppDataSource } from "../../../data-source";
import { Jobs } from "../entities/Job.entity";
import { Services } from "../../service/entities/Service.entity";
import { ServiceService } from "../../service/services/Service.Service";
import { ServiceJob } from "../../service/entities/ServiceJob.entity";
import { In, ILike, Raw } from "typeorm";
import { SecurityService } from "../../../shared/services/Security.Service";
import { normalizeNickname } from "../../../shared/helpers/TaskNickname.helper";
import { JobLevel, JobResponsibleRole } from "../../../shared/entities/Enums";

export class JobService {
    private jobRepository = AppDataSource.getRepository(Jobs);

    private normalizeJobPayload(data: any = {}) {
        if (Object.prototype.hasOwnProperty.call(data, "nickname")) {
            data.nickname = normalizeNickname(data.nickname);
        }
        if (data.isBriefVideo === true) {
            data.isQuotationItem = false;
        }
        if (Object.prototype.hasOwnProperty.call(data, "level")) {
            if (!Object.values(JobLevel).includes(data.level)) {
                throw new Error("Level của job không hợp lệ. Vui lòng chọn A, B hoặc C");
            }
        }
        if (Object.prototype.hasOwnProperty.call(data, "responsibleRole")) {
            if (data.responsibleRole === "") data.responsibleRole = null;
            if (data.responsibleRole !== null && data.responsibleRole !== undefined && !Object.values(JobResponsibleRole).includes(data.responsibleRole)) {
                throw new Error("Vai trò phụ trách job không hợp lệ");
            }
        }
        return data;
    }

    async getAll(filters: { name?: string; category?: string } = {}) {
        const query: any = {
            relations: ["vendorJobs", "vendorJobs.vendor", "serviceJobs", "serviceJobs.service", "criteria"]
        };

        if (filters.name) {
            query.where = { name: ILike(`%${filters.name}%`) };
        }
        if (filters.category) {
            query.where = { ...(query.where || {}), categories: Raw((alias) => `:category = ANY(${alias})`, { category: filters.category }) };
        }
        query.where = SecurityService.withTenant(query.where || {});

        return await this.jobRepository.find(query);
    }

    async getOne(id: string) {
        const job = await this.jobRepository.findOne({
            where: SecurityService.withTenant({ id }),
            relations: ["vendorJobs", "vendorJobs.vendor", "serviceJobs", "serviceJobs.service", "criteria"]
        });
        if (!job) throw new Error("Không tìm thấy công việc");
        return job;
    }

    async create(data: any = {}) {
        const { serviceIds, vendorId, ...jobData } = data;
        this.normalizeJobPayload(jobData);
        const normalizedCode = typeof jobData.code === "string" ? jobData.code.trim() : jobData.code;

        if (normalizedCode) {
            const existingJob = await this.jobRepository.findOne({
                where: {
                    ...SecurityService.withTenant({
                        code: Raw((alias) => `LOWER(TRIM(${alias})) = LOWER(TRIM(:code))`, { code: normalizedCode })
                    })
                },
                relations: ["vendorJobs", "vendorJobs.vendor", "serviceJobs", "serviceJobs.service", "criteria"]
            });

            if (existingJob) return existingJob;

            jobData.code = normalizedCode;
        }

        const job = this.jobRepository.create(SecurityService.withTenant(jobData) as any) as any;
        const savedJob = (await this.jobRepository.save(job)) as any;

        if (serviceIds && Array.isArray(serviceIds)) {
            const sjRepo = AppDataSource.getRepository(ServiceJob);
                const sjs = serviceIds.map(serviceId => sjRepo.create({
                    serviceId,
                    jobId: savedJob.id,
                    quantity: 1,
                    isOutput: false,
                    ...SecurityService.getTenantWhere()
                } as any) as unknown as ServiceJob);
            await sjRepo.save(sjs);
        }

        return savedJob;
    }

    async update(id: string, data: any = {}) {
        const { serviceIds, vendorId, ...jobData } = data;
        this.normalizeJobPayload(jobData);
        const job = await this.getOne(id);

        const oldCost = job.costPrice;
        Object.assign(job, jobData);

        const savedJob = (await this.jobRepository.save(job as any)) as any;

        // If cost changed or services changed, recalculate for all related services
        if (oldCost !== jobData.costPrice || serviceIds) {
            const serviceService = new ServiceService();
            const sjRepo = AppDataSource.getRepository(ServiceJob);

            if (serviceIds && Array.isArray(serviceIds)) {
                // Sync service associations
                await sjRepo.delete(SecurityService.withTenant({ jobId: id }));
                const sjs = serviceIds.map(serviceId => sjRepo.create({
                    serviceId,
                    jobId: id,
                    quantity: 1,
                    isOutput: false,
                    ...SecurityService.getTenantWhere()
                } as any) as unknown as ServiceJob);
                await sjRepo.save(sjs);
            }

            const updatedJob = (await this.jobRepository.findOne({
                where: SecurityService.withTenant({ id: savedJob.id }),
                relations: ["serviceJobs"]
            })) as any;
            
            if (updatedJob?.serviceJobs) {
                for (const sj of updatedJob.serviceJobs) {
                    await serviceService.recalculateCost(sj.serviceId);
                }
            }
        }

        return savedJob;
    }

    async delete(id: string) {
        const job = await this.getOne(id);
        await this.jobRepository.remove(job);
        return { message: "Xóa công việc thành công" };
    }
}
