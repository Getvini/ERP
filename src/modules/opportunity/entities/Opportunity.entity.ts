import { Entity, Column, ManyToOne, OneToMany } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { Customers } from "../../customer/entities/Customer.entity";
import { Quotations } from "../../quotation/entities/Quotation.entity";
import { OpportunityServices } from "../../opportunity-service/entities/OpportunityService.entity";
import { Contracts } from "../../contract/entities/Contract.entity";
import { ReferralPartners } from "../../referral-partner/entities/ReferralPartner.entity";
import { Users } from "../../user/entities/User.entity";
import { OpportunityPackages } from "./OpportunityPackage.entity";
import { OpportunityRejections } from "./OpportunityRejection.entity";

export enum CustomerType {
    DIRECT = "DIRECT", // Khách hàng trực tiếp
    REFERRAL = "REFERRAL" // Khách hàng liên kết
}

export enum OpportunityStatus {
    OPEN = "OPEN", // Mới tạo
    PENDING_OPP_APPROVAL = "PENDING_OPP_APPROVAL", // Chờ BOD duyệt cơ hội
    OPP_REJECTED = "OPP_REJECTED", // BOD không duyệt cơ hội
    OPP_APPROVED = "OPP_APPROVED", // Đã duyệt cơ hội
    QUOTATION_DRAFTING = "QUOTATION_DRAFTING", // Làm báo giá
    PENDING_QUOTE_APPROVAL = "PENDING_QUOTE_APPROVAL", // Chờ duyệt báo giá
    QUOTE_APPROVED = "QUOTE_APPROVED", // Báo giá đã duyệt
    CONTRACT_CREATED = "CONTRACT_CREATED", // Đang làm hợp đồng
    CONTRACT_APPROVED = "CONTRACT_APPROVED", // Đã tạo hợp đồng
    PROJECT_ASSIGNED = "PROJECT_ASSIGNED", // Đã phân công dự án
    IMPLEMENTATION = "IMPLEMENTATION", // Đang thực hiện
    COMPLETED = "COMPLETED",
    CANCELLED = "CANCELLED"
}

@Entity()
export class Opportunities extends BaseEntity {

    @Column({ unique: true })
    opportunityCode: string;

    @Column()
    name: string;

    @Column({ type: "text", nullable: true })
    description: string;

    @Column({ nullable: true })
    field: string;

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    expectedRevenue: number;

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    budget: number;

    @Column({ type: "date", nullable: true })
    startDate: Date;

    @Column({ type: "date", nullable: true })
    endDate: Date;

    @Column({ nullable: true })
    priority: string;

    @Column({ type: "int", default: 0 })
    successChance: number;

    @Column({
        type: "jsonb",
        nullable: true,
        default: []
    })
    region: string[];

    @Column({ type: "int", default: 0 })
    durationMonths: number;

    @Column({
        type: "enum",
        enum: OpportunityStatus,
        default: OpportunityStatus.PENDING_OPP_APPROVAL
    })
    status: OpportunityStatus;

    @Column({ type: "text", nullable: true })
    rejectionReason: string;

    // Customer Type info
    @Column({
        type: "enum",
        enum: CustomerType,
        default: CustomerType.DIRECT
    })
    customerType: CustomerType;

    // Lead Information (for Potential Customers)
    @Column({ nullable: true })
    leadName: string;

    @Column({ nullable: true })
    leadPhone: string;

    @Column({ nullable: true })
    leadEmail: string;

    @Column({ nullable: true })
    leadAddress: string;

    @Column({ nullable: true })
    leadTaxId: string;

    // Partner Commission Info
    @Column({ type: "decimal", precision: 5, scale: 2, default: 0 })
    partnerCommissionRate: number; // Tỷ lệ hoa hồng (%) - mặc định 0%

    @Column({ type: "decimal", precision: 15, scale: 2, default: 0 })
    expectedPartnerCommission: number; // Hoa hồng dự kiến - mặc định 0

    @Column({ type: "json", nullable: true })
    attachments: { type: string, name: string, url: string, size?: number, publicId?: string }[];

    // Relations
    @ManyToOne(() => Customers, (customer) => customer.opportunities, { nullable: true })
    customer: Customers;

    @ManyToOne(() => ReferralPartners, (partner) => partner.opportunities, { nullable: true })
    referralPartner: ReferralPartners;

    @OneToMany(() => Quotations, (quotation) => quotation.opportunity)
    quotations: Quotations[];

    @OneToMany(() => OpportunityPackages, (oppPackage) => oppPackage.opportunity)
    packages: OpportunityPackages[];

    @OneToMany(() => OpportunityServices, (oppService) => oppService.opportunity)
    services: OpportunityServices[];

    @OneToMany(() => Contracts, (contract) => contract.opportunity)
    contracts: Contracts[];

    @OneToMany(() => OpportunityRejections, (rejection) => rejection.opportunity)
    rejections: OpportunityRejections[];

    @ManyToOne(() => Users, (user) => user.opportunities)
    createdBy: Users;
}
