import { Entity, Column, ManyToOne, Relation, Index } from "typeorm"
import { BaseEntity } from "../../../shared/entities/BaseEntity"
import { Users } from "../../user/entities/User.entity"

@Entity()
@Index(["recipient", "createdAt"])
@Index(["recipient", "isRead", "createdAt"])
export class Notifications extends BaseEntity {

    @Column()
    title: string

    @Column({ type: "text" })
    content: string

    @Column()
    type: string

    @Column({ default: false })
    isRead: boolean

    @Column({ type: "timestamp", nullable: true })
    readAt: Date

    @Column({ nullable: true })
    link: string

    @Column({ nullable: true })
    relatedEntityId: string

    @Column({ nullable: true })
    relatedEntityType: string

    @Index()
    @ManyToOne(() => Users)
    recipient: Relation<Users>

    @ManyToOne(() => Users, { nullable: true })
    sender: Relation<Users>
}
