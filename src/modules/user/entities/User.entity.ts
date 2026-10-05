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
