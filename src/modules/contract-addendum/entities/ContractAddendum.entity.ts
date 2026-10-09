import { Entity, Column, ManyToOne, OneToMany } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { Contracts } from "../../contract/entities/Contract.entity";
import { ContractServices } from "../../contract/entities/ContractService.entity";
import { PaymentMilestones } from "../../payment-milestone/entities/PaymentMilestone.entity";
import { Quotations } from "../../quotation/entities/Quotation.entity";
import { Projects } from "../../project/entities/Project.entity";
import { Users } from "../../user/entities/User.entity";

export enum AddendumStatus {
    DRAFT = "DRAFT",
    SIGNED = "SIGNED",
    CANCELLED = "CANCELLED",
    PENDING_SALE = "PENDING_SALE",
    SALE_REJECTED = "SALE_REJECTED",
    PENDING_BOD = "PENDING_BOD",
    BOD_REJECTED = "BOD_REJECTED",
    APPROVED = "APPROVED"
}

export enum AddendumType {
    MANUAL = "MANUAL",
    MONTHLY_TASKS = "MONTHLY_TASKS",
    ADD_SERVICES = "ADD_SERVICES"
}

@Entity()
export class ContractAddendums extends BaseEntity {

    @Column()
    name: string; // e.g., "Phụ lục 01: Bổ sung hạng mục quay phim"

    @ManyToOne(() => Contracts, (contract) => contract.addendums)
    contract: Contracts;

    @ManyToOne(() => Projects, { nullable: true })
    project: Projects;

    @Column({
        type: "enum",
        enum: AddendumType,
        default: AddendumType.MANUAL
    })
    type: AddendumType;

    @Column({ type: "varchar", length: 7, nullable: true })
    monthKey: string;

    @Column({ type: "jsonb", nullable: true, default: [] })
    selectedItems: {
        sourceContractServiceId?: string,
        serviceId: string,
        serviceName: string,
        quantity?: number,
        packageKey?: string,
        packageName?: string,
        packageQuantity?: number,
        isPackageService?: boolean,
        sellingPrice?: number,
        budget?: number,
        cost?: number,
        unit?: string,
        description?: string
    }[];

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    sellingPrice: number; // Có thể âm nếu là phụ lục cắt giảm

    @Column({ type: "decimal", precision: 5, scale: 2, default: 8 })
    vatRate: number;

    @Column({ type: "decimal", precision: 18, scale: 6, default: 0 })
    vatAmount: number;

    @Column({ type: "decimal", precision: 18, scale: 6, default: 0 })
    totalWithVat: number;

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    cost: number;

    @Column({ type: "text", nullable: true })
    description: string;

    @Column({ nullable: true })
    signed_contract: string; // URL file phụ lục đã ký

    @Column({
        type: "enum",
        enum: AddendumStatus,
        default: AddendumStatus.DRAFT
    })
    status: AddendumStatus;

    @ManyToOne(() => Users, { nullable: true })
    saleReviewedBy: Users;

    @Column({ type: "timestamptz", nullable: true })
    saleReviewedAt: Date;

    @Column({ type: "text", nullable: true })
    saleReviewNote: string;

    @ManyToOne(() => Users, { nullable: true })
    bodReviewedBy: Users;

    @Column({ type: "timestamptz", nullable: true })
    bodReviewedAt: Date;

    @Column({ type: "text", nullable: true })
    bodReviewNote: string;

    @OneToMany(() => ContractServices, (service) => service.addendum)
    services: ContractServices[];

    @OneToMany(() => PaymentMilestones, (milestone) => milestone.addendum)
    milestones: PaymentMilestones[];

    @ManyToOne(() => Quotations, { nullable: true })
    quotation: Quotations;
}
