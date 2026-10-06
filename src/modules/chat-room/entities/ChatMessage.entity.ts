import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { Users } from "../../user/entities/User.entity";
import { ChatRooms } from "./ChatRoom.entity";

@Entity()
@Index(["roomId", "createdAt"])
@Index(["roomId", "id"])
export class ChatMessages extends BaseEntity {
    @Index()
    @Column({ type: "varchar", length: 26 })
    roomId: string;

    @ManyToOne(() => ChatRooms, { onDelete: "CASCADE" })
    @JoinColumn({ name: "roomId" })
    room: ChatRooms;

    @Index()
    @Column({ type: "varchar", length: 26 })
    senderId: string;

    @ManyToOne(() => Users, { onDelete: "CASCADE" })
    @JoinColumn({ name: "senderId" })
    sender: Users;

    @Column({ type: "text" })
    content: string;

    @Column({ type: "json", nullable: true })
    attachments: { type: string; name: string; url: string; size?: number; publicId?: string }[] | null;
}
