import { AppDataSource } from "../../../data-source";
import { Vendors } from "../entities/Vendor.entity";
import { VendorJobs } from "../entities/VendorJob.entity";
import { Jobs } from "../../job/entities/Job.entity";
import { validatePartnerData } from "../validations/Partner.Validation";
import { RedisService } from "../../../shared/services/Redis.Service";
import { SecurityService } from "../../../shared/services/Security.Service";

export class VendorService {
    private vendorRepository = AppDataSource.getRepository(Vendors);
    private vendorJobRepository = AppDataSource.getRepository(VendorJobs);

    async getAll() {
        return await RedisService.fetchWithCache(`vendors:${SecurityService.getTenantCachePart()}:all`, 3600, async () => {
            return await this.vendorRepository.find({
                where: SecurityService.getTenantWhere(),
                relations: ["vendorJobs"]
            });
        });
    }

    async getOne(id: string) {
        return await RedisService.fetchWithCache(`vendors:${SecurityService.getTenantCachePart()}:detail:${id}`, 3600, async () => {
            const vendor = await this.vendorRepository.findOne({
                where: SecurityService.withTenant({ id }),
                relations: ["vendorJobs", "vendorJobs.job"]
            });
            if (!vendor) throw new Error("Không tìm thấy nhà cung cấp");
            return vendor;
        });
    }

    async create(data: any) {
        validatePartnerData(data);
        const vendor = this.vendorRepository.create(SecurityService.withTenant(data));
        const saved = await this.vendorRepository.save(vendor);

        // Invalidate list cache
        await RedisService.deleteCache('vendors:all*');

        return saved;
    }

    async update(id: string, data: any) {
        validatePartnerData(data);
        const vendor = await this.getOne(id);
        Object.assign(vendor, data);
        const saved = await this.vendorRepository.save(vendor);

        // Invalidate caches
        await RedisService.deleteCache('vendors:all*');
        await RedisService.deleteCache(`vendors:detail:${id}*`);

        return saved;
    }

    async delete(id: string) {
        const vendor = await this.getOne(id);
        await this.vendorRepository.remove(vendor);

        // Invalidate caches
        await RedisService.deleteCache('vendors:all*');
        await RedisService.deleteCache(`vendors:detail:${id}*`);

        return { message: "Xóa nhà cung cấp thành công" };
    }

    // VendorJob Management
    async addJob(vendorId: string, jobId: string, priceData: { price: number, note?: string }) {
        const vendor = await this.getOne(vendorId);
        const jobRepository = AppDataSource.getRepository(Jobs);
        const job = await jobRepository.findOne({ where: SecurityService.withTenant({ id: jobId }) });

        if (!job) throw new Error("Không tìm thấy công việc (Job)");

        let vendorJob = await this.vendorJobRepository.findOne({
            where: SecurityService.withTenant({ vendor: { id: vendorId }, job: { id: jobId } })
        });

        if (vendorJob) {
            Object.assign(vendorJob, priceData);
        } else {
            vendorJob = this.vendorJobRepository.create({
                vendor,
                job,
                ...SecurityService.getTenantWhere(),
                ...priceData
            } as any) as unknown as VendorJobs;
        }

        const saved = await this.vendorJobRepository.save(vendorJob);

        // Invalidate and detail
        await RedisService.deleteCache('vendors:all*');
        await RedisService.deleteCache(`vendors:detail:${vendorId}*`);

        return saved;
    }

    async removeJob(vendorId: string, jobId: string) {
        const vendorJob = await this.vendorJobRepository.findOne({
            where: SecurityService.withTenant({ vendor: { id: vendorId }, job: { id: jobId } })
        });
        if (!vendorJob) throw new Error("Không tìm thấy hạng mục cần xóa khỏi nhà cung cấp");

        await this.vendorJobRepository.remove(vendorJob);

        // Invalidate
        await RedisService.deleteCache('vendors:all*');
        await RedisService.deleteCache(`vendors:detail:${vendorId}*`);

        return { message: "Đã xóa công việc khỏi nhà cung cấp" };
    }

    async getJobs(vendorId: string) {
        return await this.vendorJobRepository.find({
            where: SecurityService.withTenant({ vendor: { id: vendorId } }),
            relations: ["job"]
        });
    }

    async getByJob(jobId: string) {
        const vendorJobs = await this.vendorJobRepository.find({
            where: SecurityService.withTenant({ job: { id: jobId } }),
            relations: ["vendor"]
        });
        // Map to return unique vendors
        return vendorJobs.map(vj => vj.vendor);
    }
}
