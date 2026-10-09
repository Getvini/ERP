import { Entity, Column, ManyToOne, OneToMany, JoinColumn } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { Services } from "../../service/entities/Service.entity";
import { Opportunities } from "../../opportunity/entities/Opportunity.entity";
import { ContractServices } from "../../contract/entities/ContractService.entity";
import { OpportunityPackages } from "../../opportunity/entities/OpportunityPackage.entity";
import { OpportunityServiceJobs } from "./OpportunityServiceJob.entity";

@Entity()
export class OpportunityServices extends BaseEntity {

    @ManyToOne(() => Services, (service) => service.opportunityServices)
    @JoinColumn({ name: "serviceId" })
    service: Services;

    @Column({ type: "varchar", length: 26, nullable: true })
    serviceId: string;

    @ManyToOne(() => Opportunities, (opportunity) => opportunity.services)
    opportunity: Opportunities;

    @ManyToOne(() => OpportunityPackages, (pkg) => pkg.services, { nullable: true })
    @JoinColumn({ name: "opportunityPackageId" })
    opportunityPackage: OpportunityPackages;

    @Column({ type: "varchar", length: 26, nullable: true })
    opportunityPackageId: string;

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    sellingPrice: number;

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    costAtSale: number;

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    budget: number;

    @Column({ type: "int", default: 1 })
    quantity: number;

    @Column({ nullable: true })
    name: string; // Snapshot of service name

    @Column({ nullable: true })
    packageName: string; // Snapshot of package name

    @Column({ default: false })
    isPackageService: boolean;

    @OneToMany(() => ContractServices, (contractService) => contractService.opportunityService)
    contractServices: ContractServices[];

    @OneToMany(() => OpportunityServiceJobs, (item) => item.opportunityService, { cascade: true })
    jobs: OpportunityServiceJobs[];
}
