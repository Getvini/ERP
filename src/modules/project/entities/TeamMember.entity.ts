import { Entity, ManyToOne, Column, OneToMany } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { ProjectTeams } from "./ProjectTeam.entity";
import { Users } from "../../user/entities/User.entity";
import { TeamMemberRoles } from "./TeamMemberRole.entity";
import { MemberRole } from "./MemberRole.enum";

export { MemberRole } from "./MemberRole.enum";

@Entity()
export class TeamMembers extends BaseEntity {

    @ManyToOne(() => ProjectTeams, (team) => team.members, { onDelete: "CASCADE" })
    team: ProjectTeams;

    @ManyToOne(() => Users, (user) => user.teamMemberships, { onDelete: "CASCADE" })
    user: Users;

    @OneToMany(() => TeamMemberRoles, (memberRole) => memberRole.member, {
        cascade: true,
        eager: true
    })
    roles: TeamMemberRoles[];

    @Column({
        name: "role",
        type: "enum",
        enum: MemberRole,
        nullable: true,
        select: false
    })
    legacyRole?: MemberRole | null;
}

export const getMemberRoles = (member?: Pick<TeamMembers, "roles"> | null): MemberRole[] =>
    (member?.roles || []).map(item => typeof item === "string" ? item : item.role);

export const memberHasRole = (member: Pick<TeamMembers, "roles"> | null | undefined, role: MemberRole) =>
    getMemberRoles(member).includes(role);
