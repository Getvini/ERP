import { Entity, Column, ManyToOne, JoinColumn } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { Quotations } from "./Quotation.entity";
import { Services } from "../../service/entities/Service.entity";
import { Jobs } from "../../job/entities/Job.entity";
import { OpportunityServices } from "../../opportunity-service/entities/OpportunityService.entity";

@Entity()
export class QuotationDetails extends BaseEntity {

    @ManyToOne(() => Quotations, (quotation) => quotation.details, { onDelete: 'CASCADE' })
    quotation: Quotations;

    @ManyToOne(() => Services, { nullable: true })
    @JoinColumn({ name: "serviceId" })
    service: Services;

    @Column({ type: "varchar", length: 26, nullable: true })
    serviceId: string;

    @ManyToOne(() => OpportunityServices, { nullable: true })
    @JoinColumn({ name: "opportunityServiceId" })
    opportunityService: OpportunityServices;

    @Column({ type: "varchar", length: 26, nullable: true })
    opportunityServiceId: string;

    @ManyToOne(() => Jobs, { nullable: true })
    job: Jobs;

    @Column({ type: "int", default: 1 })
    quantity: number;

    @Column({ type: "decimal", precision: 18, scale: 6, default: 0 })
    sellingPrice: number; // Proposed selling price per unit

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    costAtSale: number; // Estimated cost per unit (for margin calc)

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    budget: number; // Internal delivery budget per service item

    @Column({ nullable: true })
    name: string; // Snapshot of service name

    @Column({ type: "int", default: 1, nullable: true })
    packageQuantity: number; // Quantity of the package this item belongs to

    @Column({ nullable: true })
    packageName: string;

    @Column({ nullable: true })
    packageKey: string;

    @Column({ nullable: true })
    servicePackageId: string;

    @Column({ default: false })
    isPackageService: boolean;
}
