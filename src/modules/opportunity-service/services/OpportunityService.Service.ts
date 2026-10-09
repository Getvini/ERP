import { AppDataSource } from "../../../data-source";
import { OpportunityServices } from "../entities/OpportunityService.entity";
import { Opportunities } from "../../opportunity/entities/Opportunity.entity";
import { Services } from "../../service/entities/Service.entity";
import { SecurityService } from "../../../shared/services/Security.Service";
import { OpportunityServiceJobs } from "../entities/OpportunityServiceJob.entity";
import { RedisService } from "../../../shared/services/Redis.Service";
import { calculateRecommendedSellingPrice } from "../../../shared/helpers/Pricing.helper";

export class OpportunityServiceService {
    private oppServiceRepository = AppDataSource.getRepository(OpportunityServices);
    private opportunityRepository = AppDataSource.getRepository(Opportunities);
    private serviceRepository = AppDataSource.getRepository(Services);
    private oppServiceJobRepository = AppDataSource.getRepository(OpportunityServiceJobs);

    async getAllByOpportunity(opportunityId: string) {
        return await this.oppServiceRepository.find({
            where: SecurityService.withTenant({ opportunity: { id: opportunityId } }),
            relations: ["service", "jobs", "jobs.job", "jobs.tasks"]
        });
    }

    async getOne(id: string) {
        const item = await this.oppServiceRepository.findOne({
            where: SecurityService.withTenant({ id }),
            relations: ["opportunity", "opportunity.customer", "service", "jobs", "jobs.job", "jobs.tasks"]
        });
        if (!item) throw new Error("Không tìm thấy hạng mục dịch vụ");
        return item;
    }

    async create(data: { opportunityId: string, serviceId: string, quantity: number, costAtSale?: number, budget?: number }) {
        const opportunity = await this.opportunityRepository.findOne({ where: SecurityService.withTenant({ id: data.opportunityId }) });
        if (!opportunity) throw new Error("Không tìm thấy cơ hội kinh doanh");

        const service = await this.serviceRepository.findOne({ where: SecurityService.withTenant({ id: data.serviceId }) });
        if (!service) throw new Error("Không tìm thấy dịch vụ gốc");

        const oppService = this.oppServiceRepository.create({
            opportunity,
            service,
            quantity: data.quantity || 1,
            sellingPrice: calculateRecommendedSellingPrice(Number(data.costAtSale ?? service.costPrice ?? 0)),
            costAtSale: Number(data.costAtSale ?? service.costPrice ?? 0),
            budget: Number(data.budget || 0),
            ...SecurityService.getTenantWhere()
        } as any) as unknown as OpportunityServices;

        const saved = await this.oppServiceRepository.save(oppService);
        await this.recalculateRevenue(data.opportunityId);
        return await this.getOne(saved.id);
    }

    async update(id: string, data: {
        quantity?: number,
        costAtSale?: number,
        budget?: number,
        jobs?: { id: string, costAtSale?: number, briefVideo?: string }[]
    }) {
        const item = await this.getOne(id);
        const updatesCost = data.costAtSale !== undefined || data.jobs?.some(job => job.costAtSale !== undefined);

        if (updatesCost && !item.opportunity.customer && !item.opportunity.leadName?.trim()) {
            throw new Error("Vui lòng chọn khách hàng trước khi cập nhật giá vốn dịch vụ");
        }

        const demoTasks = (item.jobs || [])
            .filter(job => job.isBriefVideo)
            .flatMap(job => job.tasks || []);
        if (updatesCost && demoTasks.length > 0 && !demoTasks.some(task => task.customerDecision === "APPROVED")) {
            throw new Error("Chỉ được nhập giá vốn sau khi BD xác nhận khách hàng duyệt mua");
        }

        if (data.quantity !== undefined) item.quantity = data.quantity;
        if (data.costAtSale !== undefined) item.costAtSale = data.costAtSale;
        if (data.budget !== undefined) item.budget = data.budget;

        if (Array.isArray(data.jobs)) {
            for (const input of data.jobs) {
                const job = item.jobs?.find((candidate) => candidate.id === input.id);
                if (!job) throw new Error("Không tìm thấy hạng mục công việc của cơ hội");

                if (input.briefVideo !== undefined) {
                    const briefVideo = input.briefVideo.trim() || null;
                    if (job.isBriefVideo && !briefVideo) {
                        throw new Error(`Vui lòng nhập brief cho hạng mục ${job.name}`);
                    }
                    job.briefVideo = briefVideo;
                }

                const isQuotationJob = job.isQuotationItem && !job.isBriefVideo;
                if (isQuotationJob) {
                    if (input.costAtSale !== undefined) job.costAtSale = input.costAtSale;
                }
                if (job.isBriefVideo) job.isQuotationItem = false;

                await this.oppServiceJobRepository.save(job);
            }

            const quotationJobs = (await this.oppServiceJobRepository.find({
                where: SecurityService.withTenant({ opportunityServiceId: id })
            })).filter((job) => job.isQuotationItem && !job.isBriefVideo);
            item.costAtSale = quotationJobs.reduce(
                (sum, job) => sum + Number(job.costAtSale || 0) * Number(job.quantity || 1), 0
            );
        }
        item.sellingPrice = calculateRecommendedSellingPrice(Number(item.costAtSale || 0));

        await this.oppServiceRepository.save(item);
        await this.recalculateRevenue(item.opportunity.id);
        await RedisService.deleteCache(`opportunities:*:detail:${item.opportunity.id}*`);
        await RedisService.deleteCache("opportunities:all*");
        return await this.getOne(id);
    }

    async delete(id: string) {
        const item = await this.getOne(id);
        const opportunityId = item.opportunity.id;
        await this.oppServiceRepository.remove(item);
        await this.recalculateRevenue(opportunityId);
        return { message: "Xóa hạng mục dịch vụ thành công" };
    }

    private async recalculateRevenue(opportunityId: string) {
        const services = await this.oppServiceRepository.find({
            where: SecurityService.withTenant({ opportunity: { id: opportunityId } })
        });

        const totalRevenue = services.reduce((sum, s) => sum + (Number(s.sellingPrice) * s.quantity), 0);

        await this.opportunityRepository.update(SecurityService.withTenant({ id: opportunityId }), {
            expectedRevenue: totalRevenue
        });
    }
}
