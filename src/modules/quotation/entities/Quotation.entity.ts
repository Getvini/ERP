import { Entity, Column, ManyToOne, OneToMany, Index } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { Opportunities } from "../../opportunity/entities/Opportunity.entity";
import { QuotationDetails } from "./QuotationDetail.entity";
import { Tasks } from "../../task/entities/Task.entity";
import { Users } from "../../user/entities/User.entity";

export enum QuotationStatus {
    DRAFT = "DRAFT",
    PENDING_APPROVAL = "PENDING_APPROVAL", // Chờ BOD duyệt
    APPROVED = "APPROVED", // Đã duyệt (Official)
    REJECTED = "REJECTED",
    ARCHIVED = "ARCHIVED"
}

export enum QuotationType {
    INITIAL = "INITIAL",
    ADDENDUM = "ADDENDUM"
}

@Entity()
@Index(["status", "createdAt"])
export class Quotations extends BaseEntity {

    @Column({ type: "text", nullable: true })
    note: string;

    @Column({ type: "int", default: 1 })
    version: number;

    @Index()
    @Column({
        type: "enum",
        enum: QuotationStatus,
        default: QuotationStatus.DRAFT
    })
    status: QuotationStatus;

    @Column({
        type: "enum",
        enum: QuotationType,
        default: QuotationType.INITIAL
    })
    type: QuotationType;

    /** Tổng giá bán chưa VAT. */
    @Column({ type: "decimal", precision: 18, scale: 6, default: 0 })
    totalAmount: number;

    @Column({ type: "decimal", precision: 5, scale: 2, default: 8 })
    vatRate: number;

    @Column({ type: "decimal", precision: 18, scale: 6, default: 0 })
    vatAmount: number;

    @Column({ type: "decimal", precision: 18, scale: 6, default: 0 })
    totalWithVat: number;

    @ManyToOne(() => Opportunities, (opportunity) => opportunity.quotations)
    opportunity: Opportunities;

    @OneToMany(() => QuotationDetails, (detail) => detail.quotation)
    details: QuotationDetails[];

    @OneToMany(() => Tasks, (task) => task.quotation, { nullable: true })
    tasks: Tasks[];

    @Column({ nullable: true })
    description: string;

    @ManyToOne(() => Users)
    createdBy: Users;
}

