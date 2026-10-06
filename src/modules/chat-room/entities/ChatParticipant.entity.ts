import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { Users } from "../../user/entities/User.entity";
import { ChatRooms } from "./ChatRoom.entity";

@Entity()
@Index(["roomId", "userId"])
export class ChatParticipants extends BaseEntity {
    @Index()
    @Column({ type: "varchar", length: 26 })
    roomId: string;

    @ManyToOne(() => ChatRooms, { onDelete: "CASCADE" })
    @JoinColumn({ name: "roomId" })
    room: ChatRooms;

    @Index()
    @Column({ type: "varchar", length: 26 })
    userId: string;

    @ManyToOne(() => Users, { onDelete: "CASCADE" })
    @JoinColumn({ name: "userId" })
    user: Users;

    @Column({ type: "timestamp", nullable: true })
    lastReadAt: Date | null;
}
