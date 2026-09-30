import { Column, Entity, ManyToOne, Unique } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { TeamMembers } from "./TeamMember.entity";
import { MemberRole } from "./MemberRole.enum";

@Entity()
@Unique(["member", "role"])
export class TeamMemberRoles extends BaseEntity {
    @ManyToOne(() => TeamMembers, (member) => member.roles, { onDelete: "CASCADE" })
    member: TeamMembers;

    @Column({ type: "enum", enum: MemberRole })
    role: MemberRole;

    toJSON() {
        return this.role;
    }
}
