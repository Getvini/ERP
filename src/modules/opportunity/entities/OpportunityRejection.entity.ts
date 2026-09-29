import { Entity, Column, ManyToOne, JoinColumn } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { Opportunities } from "./Opportunity.entity";
import { Users } from "../../user/entities/User.entity";

@Entity()
export class OpportunityRejections extends BaseEntity {
    @ManyToOne(() => Opportunities, (opportunity) => opportunity.rejections, { onDelete: "CASCADE" })
    @JoinColumn({ name: "opportunityId" })
    opportunity: Opportunities;

    @Column({ type: "varchar", length: 26 })
    opportunityId: string;

    @Column({ type: "text" })
    reason: string;

    @ManyToOne(() => Users, { nullable: true, onDelete: "SET NULL" })
    @JoinColumn({ name: "rejectedById" })
    rejectedBy: Users | null;

    @Column({ type: "varchar", length: 26, nullable: true })
    rejectedById: string | null;

    @Column({ type: "timestamp" })
    rejectedAt: Date;

    @Column({ type: "timestamp", nullable: true })
    resubmittedAt: Date | null;
}
