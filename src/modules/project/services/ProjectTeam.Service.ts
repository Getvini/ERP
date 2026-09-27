import { AppDataSource } from "../../../data-source";
import { ProjectTeams } from "../entities/ProjectTeam.entity";
import { TeamMembers, MemberRole, memberHasRole } from "../entities/TeamMember.entity";
import { TeamMemberRoles } from "../entities/TeamMemberRole.entity";
import { Users } from "../../user/entities/User.entity";
import { SecurityService } from "../../../shared/services/Security.Service";
import { UserRole } from "../../account/entities/Account.entity";
import { WorkloadService } from "../../../shared/services/Workload.Service";
import { Projects, ProjectStatus } from "../entities/Project.entity";
import { In } from "typeorm";
import { NotificationService } from "../../notification/services/Notification.Service";

type ActorInfo = { id: string; userId?: string; role: string };

export class ProjectTeamService {
    private teamRepository = AppDataSource.getRepository(ProjectTeams);
    private memberRepository = AppDataSource.getRepository(TeamMembers);
    private memberRoleRepository = AppDataSource.getRepository(TeamMemberRoles);
    private userRepository = AppDataSource.getRepository(Users);
    private workloadService = new WorkloadService();
    private notificationService = new NotificationService();

    private httpError(message: string, statusCode: number) {
        const error: any = new Error(message);
        error.statusCode = statusCode;
        return error;
    }

    private async assertTeamProjectNotClosedOrOnHold(teamId: string) {
        const project = await AppDataSource.getRepository(Projects).findOne({
            where: {
                team: { id: teamId },
                status: In([ProjectStatus.ON_HOLD, ProjectStatus.COMPLETED, ProjectStatus.CANCELLED])
            },
            select: { id: true, name: true, status: true }
        });
        if (project) {
            if (project.status === ProjectStatus.ON_HOLD) {
                throw this.httpError(`Dự án "${project.name}" đang tạm dừng. Không thể thay đổi nhân sự trong đội dự án.`, 409);
            }
            throw this.httpError(`Dự án "${project.name}" đã hoàn tất hoặc đã đóng. Không thể thay đổi nhân sự trong đội dự án.`, 400);
        }
    }

    private async getProjectByTeamId(teamId: string) {
        return AppDataSource.getRepository(Projects).findOne({
            where: SecurityService.withTenant({ team: { id: teamId } }),
            select: { id: true, name: true }
        });
    }

    private async notifyMemberAddedToProject(teamId: string, recipient: Users, actor?: ActorInfo) {
        const project = await this.getProjectByTeamId(teamId);
        if (!project) return;

        const senderUserId = actor?.userId || actor?.id;
        const sender = senderUserId
            ? await this.userRepository.findOneBy({ id: senderUserId })
            : undefined;

        await this.notificationService.createNotification({
            title: "Bạn đã được thêm vào dự án",
            content: `Bạn đã được thêm vào dự án ${project.name}`,
            type: "PROJECT_MEMBER_ADDED",
            recipient,
            sender: sender || undefined,
            relatedEntityId: project.id,
            relatedEntityType: "Project",
            link: `/projects/${project.id}`
        });
    }

    private async assertCanManageTeam(teamId: string, actor?: ActorInfo) {
        if (!actor) throw this.httpError("Bạn cần đăng nhập để quản lý team", 401);
        await this.assertTeamProjectNotClosedOrOnHold(teamId);
        if ([UserRole.ADMIN, UserRole.BOD].includes(actor.role as UserRole)) return;

        const actorUserId = actor.userId || actor.id;
        const team = await this.teamRepository.findOne({
            where: SecurityService.withTenant({ id: teamId }),
            relations: ["teamLead"]
        });
        if (!team) throw this.httpError("Không tìm thấy team", 404);

        const projectManagerMembership = await this.memberRepository.findOne({
            where: SecurityService.withTenant({
                team: { id: teamId },
                user: { id: actorUserId },
                roles: { role: MemberRole.PROJECT_MANAGER }
            })
        });
        if (actor.role !== UserRole.PM || !projectManagerMembership) {
            throw this.httpError("Bạn không có quyền quản lý team này", 403);
        }
    }

    private async assertCanMutateTeamMember(teamId: string, targetUserId: string, actor?: ActorInfo) {
        if (!actor) throw this.httpError("Bạn cần đăng nhập để quản lý team", 401);
        if (actor.role === UserRole.BOD) {
            throw this.httpError("BOD không được thêm, cập nhật hoặc xóa nhân sự của đội dự án", 403);
        }

        await this.assertCanManageTeam(teamId, actor);

        const actorUserId = actor.userId || actor.id;
        if (actor.role === UserRole.PM && actorUserId === targetUserId) {
            throw this.httpError("PM không được tự thêm hoặc cập nhật vai trò của bản thân", 403);
        }

        const assignedProjectManager = await this.memberRepository.findOne({
            where: SecurityService.withTenant({
                team: { id: teamId },
                user: { id: targetUserId },
                roles: { role: MemberRole.PROJECT_MANAGER }
            })
        });
        if (assignedProjectManager) {
            throw this.httpError(
                "PM đã phân công có vai trò cố định. Vui lòng dùng chức năng phân công PM để thay đổi",
                403
            );
        }
    }

    private async syncAccountRoleAsLead(member: TeamMembers) {
        const team = await this.teamRepository.findOne({
            where: SecurityService.withTenant({ id: member.team.id }),
            relations: ["teamLead", "members", "members.user"]
        });
        if (!team) throw this.httpError("Không tìm thấy team", 404);

        if (memberHasRole(member, MemberRole.ACCOUNT)) {
            // Một team có thể có nhiều Lead dự án. teamLead chỉ là Lead chính;
            // thêm Lead mới không được gỡ vai trò ACCOUNT của các Lead hiện có.
            if (!team.teamLead) {
                team.teamLead = member.user;
                await this.teamRepository.save(team);
            }
            return;
        }

        if (team.teamLead?.id === member.user?.id) {
            const replacementLead = (team.members || []).find(item =>
                item.id !== member.id && memberHasRole(item, MemberRole.ACCOUNT)
            );
            team.teamLead = replacementLead?.user || null as any;
            await this.teamRepository.save(team);
        }
    }

    async getAll() {
        return await this.teamRepository.find({
            where: SecurityService.getTenantWhere(),
            relations: ["teamLead", "teamLead.accounts", "members", "members.user", "members.user.accounts"]
        });
    }

    async getOne(id: string) {
        const team = await this.teamRepository.findOne({
            where: SecurityService.withTenant({ id }),
            relations: ["teamLead", "teamLead.accounts", "members", "members.user", "members.user.accounts"]
        });
        if (!team) throw new Error("Không tìm thấy team");
        return team;
    }

    async getMembers(teamId: string, month?: number, year?: number) {
        const team = await this.teamRepository.findOne({
            where: SecurityService.withTenant({ id: teamId }),
            relations: ["members", "members.user", "members.user.accounts"]
        });
        if (!team) throw new Error("Không tìm thấy team");
        const userIds = (team.members || []).map(member => member.user?.id).filter(Boolean);
        const workloads = await this.workloadService.getWorkloadsForUsers(userIds, month, year);

        return (team.members || []).map(member => ({
            ...member,
            user: member.user ? {
                ...member.user,
                workload: workloads.get(member.user.id) || null
            } : member.user
        }));
    }


    async create(data: { name: string, teamLeadId: string }, actor?: ActorInfo) {
        if (!actor || ![UserRole.ADMIN, UserRole.BOD].includes(actor.role as UserRole)) {
            throw this.httpError("Bạn không có quyền tạo team", 403);
        }
        const teamLead = await this.userRepository.findOneBy({ id: data.teamLeadId });
        if (!teamLead) throw new Error("Không tìm thấy team lead");

        const team = this.teamRepository.create({
            name: data.name,
            teamLead: teamLead,
            ...SecurityService.getTenantWhere()
        } as any);

        return await this.teamRepository.save(team);
    }

    async update(id: string, data: { name?: string, teamLeadId?: string }, actor?: ActorInfo) {
        await this.assertCanManageTeam(id, actor);
        const team = await this.getOne(id);

        if (data.name) team.name = data.name;
        if (data.teamLeadId) {
            const updatedTeam = await this.changeLead(id, data.teamLeadId, actor);
            team.teamLead = updatedTeam.teamLead;
        }

        return await this.teamRepository.save(team);
    }

    async changeLead(teamId: string, newLeadId: string, actor?: ActorInfo) {
        if (!actor || ![UserRole.ADMIN, UserRole.BOD].includes(actor.role as UserRole)) {
            throw this.httpError("Bạn không có quyền đổi lead trực tiếp", 403);
        }
        await this.assertTeamProjectNotClosedOrOnHold(teamId);
        const team = await this.teamRepository.findOne({
            where: SecurityService.withTenant({ id: teamId }),
            relations: ["teamLead", "members", "members.user"]
        });
        if (!team) throw new Error("Không tìm thấy team");

        const newLead = await this.userRepository.findOneBy({ id: newLeadId });
        if (!newLead) throw new Error("Không tìm thấy người dùng làm team lead mới");

        const existingMember = team.members?.find(member => member.user?.id === newLeadId);
        if (!existingMember) {
            const member = this.memberRepository.create({
                team,
                user: newLead,
                roles: [this.memberRoleRepository.create({ role: MemberRole.CONTENT_CREATOR })],
                ...SecurityService.getTenantWhere()
            } as Partial<TeamMembers>);
            await this.memberRepository.save(member);
        }

        team.teamLead = newLead;
        return await this.teamRepository.save(team);
    }

    async delete(id: string, actor?: ActorInfo) {
        if (!actor || ![UserRole.ADMIN, UserRole.BOD].includes(actor.role as UserRole)) {
            throw this.httpError("Bạn không có quyền xóa team", 403);
        }
        const team = await this.getOne(id);
        // Important: Should we delete members first? TypeORM might handle it if cascade is set, 
        // but let's be safe.
        await this.memberRepository.delete(SecurityService.withTenant({ team: { id: id } }));
        return await this.teamRepository.remove(team);
    }

    async addMember(teamId: string, userId: string, role?: MemberRole, actor?: ActorInfo, roles?: MemberRole[]) {
        const requestedRoles = Array.from(new Set(
            roles?.length ? roles : [role || MemberRole.CONTENT_CREATOR]
        ));
        if (requestedRoles.includes(MemberRole.PROJECT_MANAGER)) {
            throw this.httpError("Vai trò Quản lý dự án chỉ được tạo tại chức năng phân công PM", 400);
        }
        await this.assertCanMutateTeamMember(teamId, userId, actor);
        const team = await this.getOne(teamId);
        const user = await this.userRepository.findOneBy({ id: userId });
        if (!user) throw new Error("Không tìm thấy người dùng");

        let member = await this.memberRepository.findOne({
            where: SecurityService.withTenant({
                team: { id: teamId },
                user: { id: userId }
            }),
            relations: ["team", "user"]
        });
        const isNewMember = !member;
        const existingRoles = new Set((member?.roles || []).map(item => item.role));
        if (requestedRoles.some(memberRole => existingRoles.has(memberRole))) {
            throw this.httpError("Nhân sự đã có một hoặc nhiều vai trò được chọn trong đội dự án", 409);
        }

        if (!member) {
            member = await this.memberRepository.save(this.memberRepository.create({
                team,
                user,
                ...SecurityService.getTenantWhere()
            } as Partial<TeamMembers>));
        }
        const newRoles = requestedRoles.map(role => this.memberRoleRepository.create({ member, role }));
        await this.memberRoleRepository.save(newRoles);
        member.roles = [...(member.roles || []), ...newRoles];
        if (requestedRoles.includes(MemberRole.ACCOUNT)) await this.syncAccountRoleAsLead(member);
        if (isNewMember) await this.notifyMemberAddedToProject(teamId, user, actor);
        return member;
    }

    async updateMember(memberId: string, data: { role?: MemberRole }, actor?: ActorInfo) {
        const member = await this.memberRepository.findOne({
            where: SecurityService.withTenant({ id: memberId }),
            relations: ["team", "user"]
        });
        if (!member) throw new Error("Không tìm thấy thành viên");
        await this.assertCanMutateTeamMember(member.team.id, member.user.id, actor);

        if (data.role === MemberRole.PROJECT_MANAGER) {
            throw this.httpError("Vai trò Quản lý dự án chỉ được thay đổi tại chức năng phân công PM", 400);
        }

        if (!data.role) return member;
        return (await this.updateMemberRoles(member.team.id, member.user.id, [data.role], actor))[0];
    }

    async updateMemberRoles(teamId: string, userId: string, roles: MemberRole[], actor?: ActorInfo) {
        await this.assertCanMutateTeamMember(teamId, userId, actor);

        const requestedRoles = Array.from(new Set(roles || []));
        if (requestedRoles.length === 0) {
            throw this.httpError("Nhân sự phải có ít nhất một vai trò trong đội dự án", 400);
        }
        if (requestedRoles.some(role => !Object.values(MemberRole).includes(role))) {
            throw this.httpError("Danh sách vai trò không hợp lệ", 400);
        }
        if (requestedRoles.includes(MemberRole.PROJECT_MANAGER)) {
            throw this.httpError("Vai trò Quản lý dự án chỉ được thay đổi tại chức năng phân công PM", 400);
        }

        const membership = await this.memberRepository.findOne({
            where: SecurityService.withTenant({ team: { id: teamId }, user: { id: userId } }),
            relations: ["team", "team.teamLead", "user", "roles"]
        });
        if (!membership) throw this.httpError("Không tìm thấy thành viên", 404);

        const hadAccountRole = memberHasRole(membership, MemberRole.ACCOUNT);
        if (hadAccountRole && !requestedRoles.includes(MemberRole.ACCOUNT)) {
            const allTeamMembers = await this.memberRepository.find({
                where: SecurityService.withTenant({ team: { id: teamId } }),
                relations: ["roles", "user"]
            });
            const otherAccountMembers = allTeamMembers.filter(m =>
                m.user?.id !== userId && memberHasRole(m, MemberRole.ACCOUNT)
            );
            if (otherAccountMembers.length === 0) {
                throw this.httpError("Đội dự án phải có ít nhất 1 nhân sự giữ vai trò Account/Lead dự án. Không thể gỡ bỏ vai trò này.", 400);
            }
        }

        const currentRoles = new Set((membership.roles || []).map(item => item.role));
        const rolesToRemove = (membership.roles || []).filter(item => !requestedRoles.includes(item.role));
        if (rolesToRemove.length > 0) await this.memberRoleRepository.remove(rolesToRemove);

        const team = membership.team;
        const rolesToAdd = requestedRoles.filter(role => !currentRoles.has(role));
        if (rolesToAdd.length > 0) {
            await this.memberRoleRepository.save(rolesToAdd.map(role =>
                this.memberRoleRepository.create({ member: membership, role })
            ));
        }

        const savedMembership = await this.memberRepository.findOne({
            where: SecurityService.withTenant({ id: membership.id }),
            relations: ["team", "team.teamLead", "user", "user.accounts"]
        });
        if (!savedMembership) throw this.httpError("Không tìm thấy thành viên", 404);
        if (memberHasRole(savedMembership, MemberRole.ACCOUNT)) {
            await this.syncAccountRoleAsLead(savedMembership);
        } else if (team.teamLead?.id === userId) {
            team.teamLead = null as any;
            await this.teamRepository.save(team);
        }

        return [savedMembership];
    }

    async removeMember(memberId: string, actor?: ActorInfo) {
        const member = await this.memberRepository.findOne({
            where: SecurityService.withTenant({ id: memberId }),
            relations: ["team", "team.teamLead", "user", "roles"]
        });
        if (!member) throw new Error("Không tìm thấy thành viên");
        await this.assertCanMutateTeamMember(member.team.id, member.user.id, actor);

        const hasAccountRole = memberHasRole(member, MemberRole.ACCOUNT) || (member.team?.teamLead?.id === member.user?.id);
        if (hasAccountRole) {
            const allTeamMembers = await this.memberRepository.find({
                where: SecurityService.withTenant({ team: { id: member.team.id } }),
                relations: ["roles", "user"]
            });
            const otherAccountMembers = allTeamMembers.filter(m =>
                m.user?.id !== member.user?.id && memberHasRole(m, MemberRole.ACCOUNT)
            );
            if (otherAccountMembers.length === 0) {
                throw this.httpError("Đội dự án phải có ít nhất 1 nhân sự giữ vai trò Account/Lead dự án. Không thể xóa nhân sự này.", 400);
            }
            if (member.team && member.team.teamLead && member.user?.id === member.team.teamLead.id) {
                member.team.teamLead = otherAccountMembers[0].user;
                await this.teamRepository.save(member.team);
            }
        } else if (member.team && member.team.teamLead && member.user.id === member.team.teamLead.id) {
            throw new Error("Không thể xóa thành viên đang là Team Lead. Vui lòng chỉ định Lead mới trước khi xóa.");
        }
        return await this.memberRepository.remove(member);
    }
}
