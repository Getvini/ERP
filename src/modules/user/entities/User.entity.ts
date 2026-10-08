import { Entity, Column, OneToMany } from "typeorm"
import { BaseEntity } from "../../../shared/entities/BaseEntity"
import { Accounts } from "../../account/entities/Account.entity"
import { TeamMembers } from "../../project/entities/TeamMember.entity"
import { ProjectTeams } from "../../project/entities/ProjectTeam.entity"
import { Tasks } from "../../task/entities/Task.entity"
import { Opportunities } from "../../opportunity/entities/Opportunity.entity"

@Entity()
export class Users extends BaseEntity {

    @Column()
    fullName: string

    @Column()
    phoneNumber: string

    @Column({ type: "date", nullable: true })
    birthday: string | null

    @Column({ default: false })
    isLocked: boolean

    // 🖼️ Ảnh đại diện (Cloudinary URL)
    @Column({ nullable: true })
    avatarUrl: string | null

    // 💼 Link Portfolio (1 link duy nhất)
    @Column({ nullable: true })
    portfolioUrl: string | null

    // 🎯 Sở thích cá nhân (danh sách tags)
    @Column({ type: "simple-json", nullable: true })
    hobbies: string[] | null

    // 🪪 CCCD 2 mặt (chỉ Admin/BOD/chính chủ được xem)
    @Column({ type: "simple-json", nullable: true })
    idCard: { frontUrl?: string; backUrl?: string; idNumber?: string } | null

    @OneToMany(() => Accounts, (account) => account.user)
    accounts: Accounts[]

    @OneToMany(() => TeamMembers, (teamMember) => teamMember.user)
    teamMemberships: TeamMembers[]

    @OneToMany(() => ProjectTeams, (projectTeam) => projectTeam.teamLead)
    ledTeams: ProjectTeams[]

    @OneToMany(() => Tasks, (task) => task.assignee)
    tasks: Tasks[]

    @OneToMany(() => Opportunities, (opportunity) => opportunity.createdBy)
    opportunities: Opportunities[]

    @Column({ type: "simple-json", nullable: true })
    laborContract: any[]
}
