import { Entity, Column, ManyToOne, OneToOne, JoinColumn, OneToMany, Index } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { Contracts } from "../../contract/entities/Contract.entity";
import { PaymentMilestones } from "../../payment-milestone/entities/PaymentMilestone.entity";
import { DebtPayments } from "./DebtPayment.entity";
import { Users } from "../../user/entities/User.entity";

export enum DebtStatus {
    UNPAID = "UNPAID",
    PARTIAL = "PARTIAL",
    PAID = "PAID",
    OVERDUE = "OVERDUE",
    LOCKED = "LOCKED"
}

@Entity()
@Index(["status", "dueDate"])
export class Debts extends BaseEntity {

    @Index()
    @ManyToOne(() => Contracts, (contract) => contract.debts)
    contract: Contracts;

    @OneToOne(() => PaymentMilestones, (milestone) => milestone.debt)
    @JoinColumn()
    milestone: PaymentMilestones;

    @Column({ type: "decimal", precision: 15, scale: 3 })
    amount: number;

    @Column({ type: "date" })
    dueDate: Date;

    @Index()
    @Column({
        type: "enum",
        enum: DebtStatus,
        default: DebtStatus.UNPAID
    })
    status: DebtStatus;

    @Column()
    name: string;

    // ─────────────────────────────────────────────────────────────────────
    // KHÓA CÔNG NỢ KHI DỰ ÁN ĐÓNG
    // Debt chưa PAID → LOCKED. Debt đã PAID giữ nguyên.
    // ─────────────────────────────────────────────────────────────────────

    @Column({ type: "timestamptz", nullable: true })
    lockedAt: Date;

    @Column({ type: "text", nullable: true })
    lockReason: string;

    @ManyToOne(() => Users, { nullable: true })
    @JoinColumn({ name: "lockedById" })
    lockedBy: Users;

    @Column({ type: "varchar", length: 26, nullable: true })
    lockedById: string;

    // ── Mở khóa (chỉ BOD/ADMIN, bắt buộc nhập lý do) ────────────────────

    @Column({ type: "timestamptz", nullable: true })
    unlockedAt: Date;

    @Column({ type: "text", nullable: true })
    unlockReason: string;

    @ManyToOne(() => Users, { nullable: true })
    @JoinColumn({ name: "unlockedById" })
    unlockedBy: Users;

    @Column({ type: "varchar", length: 26, nullable: true })
    unlockedById: string;

    @OneToMany(() => DebtPayments, (payment) => payment.debt)
    payments: DebtPayments[];
}
