import { Entity, Column, ManyToOne, OneToOne, OneToMany, Index } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { Customers } from "../../customer/entities/Customer.entity";
import { Opportunities } from "../../opportunity/entities/Opportunity.entity";
import { Projects } from "../../project/entities/Project.entity";
import { PaymentMilestones } from "../../payment-milestone/entities/PaymentMilestone.entity";
import { Debts } from "../../debt/entities/Debt.entity";
import { ContractServices } from "./ContractService.entity";
import { ReferralPartners } from "../../referral-partner/entities/ReferralPartner.entity";
import { ContractAddendums } from "../../contract-addendum/entities/ContractAddendum.entity";
import { Users } from "../../user/entities/User.entity";
import { AcceptanceMinutes } from "../../finance-document/entities/AcceptanceMinute.entity";
import { VatInvoices } from "../../finance-document/entities/VatInvoice.entity";

export enum ContractStatus {
    DRAFT = "DRAFT",
    PROPOSAL_UPLOADED = "PROPOSAL_UPLOADED",
    PROPOSAL_APPROVED = "PROPOSAL_APPROVED",
    PROPOSAL_REJECTED = "PROPOSAL_REJECTED",
    SIGNED = "SIGNED",
    COMPLETED = "COMPLETED",
    CANCELLED = "CANCELLED"
}

export enum PartnerCommissionStatus {
    PENDING = "PENDING", // Chưa thanh toán
    PAID = "PAID", // Đã thanh toán
    CANCELLED = "CANCELLED" // Hủy bỏ
}

@Entity()
@Index(["status", "createdAt"])
export class Contracts extends BaseEntity {

    @Index()
    @Column({
        type: "enum",
        enum: ContractStatus,
        default: ContractStatus.DRAFT
    })
    status: ContractStatus;

    @Column({ unique: true })
    contractCode: string;

    @Column()
    name: string;

    @ManyToOne(() => Customers, (customer) => customer.contracts)
    customer: Customers;

    @ManyToOne(() => Opportunities, (opportunity) => opportunity.contracts)
    opportunity: Opportunities;

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    cost: number;

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    sellingPrice: number;

    @Column({ type: "decimal", precision: 5, scale: 2, default: 8 })
    vatRate: number;

    @Column({ type: "decimal", precision: 18, scale: 6, default: 0 })
    vatAmount: number;

    /** Tổng khách hàng phải thanh toán, đã gồm VAT. */
    @Column({ type: "decimal", precision: 18, scale: 6, default: 0 })
    totalWithVat: number;

    // Partner Commission Info
    @ManyToOne(() => ReferralPartners, { nullable: true })
    referralPartner: ReferralPartners;

    @Column({ type: "decimal", precision: 5, scale: 2, default: 0, nullable: true })
    partnerCommissionRate: number; // Tỷ lệ hoa hồng (%) - mặc định 0%

    @Column({ type: "decimal", precision: 15, scale: 2, default: 0, nullable: true })
    partnerCommission: number; // Hoa hồng thực tế - mặc định 0

    @Column({
        type: "enum",
        enum: PartnerCommissionStatus,
        default: PartnerCommissionStatus.PENDING
    })
    partnerCommissionStatus: PartnerCommissionStatus;

    @Column({ type: "timestamp", nullable: true })
    partnerCommissionPaidAt: Date; // Ngày thanh toán hoa hồng

    @Column({ nullable: true })
    proposal_contract: string; // Cloudinary URL

    @Column({ nullable: true })
    quotation_link: string; // Optional external quotation URL

    @Column({ nullable: true })
    signed_contract: string; // Cloudinary URL

    @Column({ type: "json", nullable: true })
    attachments: { type: string, name: string, url: string, size?: number, publicId?: string }[];

    @OneToMany(() => PaymentMilestones, (milestone) => milestone.contract)
    milestones: PaymentMilestones[];

    @OneToOne(() => Projects, (project) => project.contract)
    project: Projects;

    @OneToMany(() => ContractServices, (service) => service.contract)
    services: ContractServices[];

    @OneToMany(() => Debts, (debt) => debt.contract)
    debts: Debts[];

    @OneToMany(() => ContractAddendums, (addendum) => addendum.contract)
    addendums: ContractAddendums[];

    @OneToMany(() => AcceptanceMinutes, (minute) => minute.contract)
    acceptanceMinutes: AcceptanceMinutes[];

    @OneToMany(() => VatInvoices, (invoice) => invoice.contract)
    vatInvoices: VatInvoices[];

    @Column({ type: "text", nullable: true })
    rejectionReason: string;

    @Column({ type: "text", nullable: true })
    description: string;

    @ManyToOne(() => Users)
    createdBy: Users;
}
