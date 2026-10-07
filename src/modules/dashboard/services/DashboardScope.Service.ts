import { In } from "typeorm";
import { AppDataSource } from "../../../data-source";
import { UserRole } from "../../account/entities/Account.entity";
import { ProjectStatus, Projects } from "../../project/entities/Project.entity";
import { MemberRole, getMemberRoles, memberHasRole } from "../../project/entities/TeamMember.entity";
import { Tasks } from "../../task/entities/Task.entity";
import { Users } from "../../user/entities/User.entity";
import {
    DashboardScopeError,
    ResolvedDashboardScope,
    resolveDashboardScope
} from "./Dashboard.Scope";

export type DashboardActor = {
    id: string;
    userId?: string;
    role: UserRole;
};

export type DashboardProjectOption = {
    id: string;
    name: string;
    status: ProjectStatus;
    clientName?: string;
};

export type DashboardMemberOption = {
    id: string;
    role: string;
    user: {
        id: string;
        fullName: string;
        role?: string;
    };
};

export type DashboardScopeContext = ResolvedDashboardScope & {
    viewerUserId: string;
    viewerRole: UserRole;
    availableProjects: DashboardProjectOption[];
    availableMembers: DashboardMemberOption[];
    activeProjects?: Projects[];
};

const ACTIVE_PROJECT_STATUSES = [
    ProjectStatus.PENDING_CONFIRMATION,
    ProjectStatus.CONFIRMED,
    ProjectStatus.IN_PROGRESS
];

export class DashboardScopeService {
    private projectRepo = AppDataSource.getRepository(Projects);
    private taskRepo = AppDataSource.getRepository(Tasks);
    private userRepo = AppDataSource.getRepository(Users);

    async resolve(
        actor: DashboardActor,
        requestedUserId?: string,
        requestedProjectId?: string,
        mode?: "personal" | "management"
    ): Promise<DashboardScopeContext> {
        const viewerUserId = actor.userId;
        if (!viewerUserId) {
            throw new DashboardScopeError("Tài khoản chưa được liên kết với nhân sự", 403);
        }

        const isSystemViewer = [UserRole.ADMIN, UserRole.BOD].includes(actor.role);
        const isPMViewer = actor.role === UserRole.PM;
        const requestedAnotherUser = Boolean(requestedUserId && requestedUserId !== viewerUserId);
        const needPersonalProjects = requestedAnotherUser || (!isSystemViewer && (!isPMViewer || mode === "personal"));

        const [allActiveProjects, systemUsers, personalProjects] = await Promise.all([
            this.projectRepo.find({
                where: isSystemViewer
                    ? { status: In(ACTIVE_PROJECT_STATUSES) }
                    : [
                        { status: In(ACTIVE_PROJECT_STATUSES), team: { teamLead: { id: viewerUserId } } },
                        { status: In(ACTIVE_PROJECT_STATUSES), team: { members: { user: { id: viewerUserId } } } }
                    ],
                relations: isSystemViewer
                    ? ["contract", "contract.customer"]
                    : [
                        "contract",
                        "contract.customer",
                        "team",
                        "team.teamLead",
                        "team.members",
                        "team.members.user"
                    ],
                order: { createdAt: "DESC" }
            }),
            isSystemViewer
                ? this.userRepo.find({
                    where: { isLocked: false },
                    relations: ["accounts"],
                    order: { fullName: "ASC" }
                })
                : Promise.resolve([]),
            needPersonalProjects
                ? this.findPersonalProjects(viewerUserId)
                : Promise.resolve([])
        ]);

        const isExcludedSaleRole = [UserRole.BD, UserRole.ADMIN_SALE].includes(actor.role);

        const isTeamLeadOrAccount = !isExcludedSaleRole && !isSystemViewer && allActiveProjects.some(project =>
            project.team?.members?.some(member =>
                member.user?.id === viewerUserId && memberHasRole(member, MemberRole.ACCOUNT)
            ) ||
            (project.team?.teamLead?.id === viewerUserId && actor.role !== UserRole.PM)
        );

        const isAccountViewer = isTeamLeadOrAccount;

        const managedProjects = isExcludedSaleRole ? [] : allActiveProjects.filter(project => {
            if (project.team?.teamLead?.id === viewerUserId) return true;

            return project.team?.members?.some(member => {
                if (member.user?.id !== viewerUserId) return false;
                return actor.role === UserRole.PM
                    ? memberHasRole(member, MemberRole.PROJECT_MANAGER)
                    : memberHasRole(member, MemberRole.ACCOUNT);
            });
        });

        const managedMemberRoles = new Map<string, string>();
        managedProjects.forEach(project => {
            const lead = project.team?.teamLead;
            if (lead?.id && !managedMemberRoles.has(lead.id)) {
                managedMemberRoles.set(lead.id, MemberRole.ACCOUNT);
            }
            project.team?.members?.forEach(member => {
                if (member.user?.id && !managedMemberRoles.has(member.user.id)) {
                    managedMemberRoles.set(member.user.id, getMemberRoles(member)[0] || "MEMBER");
                }
            });
        });
        managedMemberRoles.set(viewerUserId, managedMemberRoles.get(viewerUserId) || actor.role);

        const targetUserId = requestedUserId || viewerUserId;
        const targetPersonalProjects = targetUserId === viewerUserId
            ? personalProjects
            : (needPersonalProjects ? await this.findPersonalProjects(targetUserId) : []);

        const resolved = resolveDashboardScope({
            viewerUserId,
            viewerRole: actor.role,
            isAccountViewer,
            requestedUserId,
            requestedProjectId,
            mode,
            managedProjectIds: managedProjects.map(project => project.id),
            managedMemberIds: Array.from(managedMemberRoles.keys()),
            personalProjectIds: personalProjects.map(project => project.id),
            targetPersonalProjectIds: targetPersonalProjects.map(project => project.id),
            systemProjectIds: allActiveProjects.map(project => project.id),
            systemMemberIds: systemUsers.map(user => user.id)
        });

        const projectById = new Map(allActiveProjects.map(project => [project.id, project]));
        const availableProjects = resolved.projectIds
            .map(id => projectById.get(id))
            .filter((project): project is Projects => Boolean(project))
            .map(project => this.toProjectOption(project));

        const availableMembers = resolved.canSelectMembers
            ? (isSystemViewer
                ? systemUsers
                    .filter(user => resolved.memberIds.includes(user.id))
                    .map(user => this.toMemberOption(user, user.accounts?.[0]?.role || "MEMBER"))
                : this.getManagedMemberOptions(managedProjects, resolved.memberIds, managedMemberRoles))
            : [];

        return {
            ...resolved,
            viewerUserId,
            viewerRole: actor.role,
            availableProjects,
            availableMembers,
            activeProjects: allActiveProjects
        };
    }

    private async findPersonalProjects(userId: string) {
        const taskProjects = await this.taskRepo.find({
            where: { assignee: { id: userId }, project: { status: In(ACTIVE_PROJECT_STATUSES) } },
            relations: ["project"]
        });
        const taskProjectIds = new Set(taskProjects.map(task => task.project?.id).filter(Boolean));

        return this.projectRepo.find({
            where: [
                { status: In(ACTIVE_PROJECT_STATUSES), team: { teamLead: { id: userId } } },
                { status: In(ACTIVE_PROJECT_STATUSES), team: { members: { user: { id: userId } } } },
                ...(taskProjectIds.size > 0
                    ? [{ status: In(ACTIVE_PROJECT_STATUSES), id: In(Array.from(taskProjectIds) as string[]) }]
                    : [])
            ],
            relations: ["contract", "contract.customer"],
            order: { createdAt: "DESC" }
        });
    }

    private getManagedMemberOptions(
        projects: Projects[],
        allowedMemberIds: string[],
        roles: Map<string, string>
    ) {
        const users = new Map<string, Users>();
        projects.forEach(project => {
            if (project.team?.teamLead?.id) users.set(project.team.teamLead.id, project.team.teamLead);
            project.team?.members?.forEach(member => {
                if (member.user?.id) users.set(member.user.id, member.user);
            });
        });

        return allowedMemberIds
            .map(id => users.get(id))
            .filter((user): user is Users => Boolean(user))
            .map(user => this.toMemberOption(user, roles.get(user.id) || "MEMBER"))
            .sort((a, b) => a.user.fullName.localeCompare(b.user.fullName, "vi"));
    }

    private toProjectOption(project: Projects): DashboardProjectOption {
        return {
            id: project.id,
            name: project.name,
            status: project.status,
            clientName: project.contract?.customer?.name
        };
    }

    private toMemberOption(user: Users, role: string): DashboardMemberOption {
        return {
            id: `dashboard-${user.id}`,
            role,
            user: {
                id: user.id,
                fullName: user.fullName,
                role: user.accounts?.[0]?.role
            }
        };
    }
}
