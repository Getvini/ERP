import axios from "axios";
import { AppDataSource } from "../../../data-source";
import { SecurityService } from "../../../shared/services/Security.Service";
import { UserRole } from "../../account/entities/Account.entity";
import { Users } from "../../user/entities/User.entity";
import { Projects, ProjectStatus } from "../entities/Project.entity";
import { MemberRole, TeamMembers, memberHasRole } from "../entities/TeamMember.entity";
import { ulid } from "ulid";
import {
    ProjectProductDescriptionStatus,
    ProjectProductDescriptionSubmissions
} from "../entities/ProjectProductDescriptionSubmission.entity";
import { ProjectProductDescriptionItems } from "../entities/ProjectProductDescriptionItem.entity";
import { NotificationService } from "../../notification/services/Notification.Service";
import {
    assertAiServiceUrl,
    AI_SERVICE_MAX_FETCH_BYTES,
    AI_SERVICE_REQUEST_TIMEOUT_MS
} from "../../../shared/config/aiService";

type Actor = { id: string; userId?: string; role: string; username?: string };

type ProductDescriptionDocumentInput = {
    url?: string;
    name?: string;
};

type ProductDescriptionItemInput = {
    id?: string | null;
    productName?: string;
    fileUrl?: string;
    fileName?: string;
    extractedText?: string | null;
    note?: string;
    documents?: ProductDescriptionDocumentInput[];
};

type ProductDescriptionPayload = {
    items?: ProductDescriptionItemInput[];
    reviewNote?: string;
};

export class ProjectProductDescriptionService {
    private projectRepository = AppDataSource.getRepository(Projects);
    private userRepository = AppDataSource.getRepository(Users);
    private submissionRepository = AppDataSource.getRepository(ProjectProductDescriptionSubmissions);
    private itemRepository = AppDataSource.getRepository(ProjectProductDescriptionItems);
    private teamMemberRepository = AppDataSource.getRepository(TeamMembers);
    private notificationService = new NotificationService();

    private httpError(message: string, statusCode: number) {
        const error = new Error(message) as Error & { statusCode?: number };
        error.statusCode = statusCode;
        return error;
    }

    private getActorUserId(actor?: Actor) {
        if (!actor?.userId) {
            throw this.httpError("Bạn cần đăng nhập để thực hiện hành động này", 401);
        }
        return actor.userId;
    }

    private async assertProjectAccess(projectId: string, actor?: Actor) {
        if (!actor) throw this.httpError("Bạn cần đăng nhập để thực hiện hành động này", 401);

        let where: any = { id: projectId };
        let rbacWhere: any = {};
        try {
            rbacWhere = SecurityService.getProjectFilters(actor);
        } catch (error: any) {
            if (error.message === "FORBIDDEN_ACCESS") {
                throw this.httpError("Bạn không có quyền truy cập dự án này", 403);
            }
            throw error;
        }
        where = Array.isArray(rbacWhere)
            ? rbacWhere.map((condition) => ({ id: projectId, ...condition }))
            : { id: projectId, ...rbacWhere };

        const project = await this.projectRepository.findOne({
            where,
            relations: ["team", "team.teamLead", "team.members", "team.members.user"]
        });

        if (!project) throw this.httpError("Không tìm thấy dự án hoặc bạn không có quyền truy cập", 404);
        return project;
    }

    private assertAssignedPm(project: Projects, actor?: Actor) {
        if (actor?.role !== UserRole.PM || !actor.userId) {
            throw this.httpError("Chỉ PM phụ trách dự án được duyệt thông tin chuẩn sản phẩm", 403);
        }

        const isAssignedPm = project.team?.members?.some((member) =>
            memberHasRole(member, MemberRole.PROJECT_MANAGER) &&
            member.user?.id === actor.userId
        );

        if (!isAssignedPm) {
            throw this.httpError("Chỉ PM phụ trách dự án được duyệt thông tin chuẩn sản phẩm", 403);
        }
    }

    // Account = "Lead dự án": team lead của dự án hoặc thành viên team mang role ACCOUNT
    // (khớp với `isAccount` ở FE ProjectInfo.jsx).
    private isProjectAccount(project: Projects, actorUserId: string) {
        const isTeamLead = project.team?.teamLead?.id === actorUserId;
        const isAccountMember = project.team?.members?.some((member) =>
            memberHasRole(member, MemberRole.ACCOUNT) &&
            member.user?.id === actorUserId
        );
        return Boolean(isTeamLead || isAccountMember);
    }

    // Quyền NHẬP (tạo/sửa/gửi duyệt/trích xuất/AI format) thông tin chuẩn sản phẩm:
    // Account (Lead dự án) và PM phụ trách. BD không còn quyền này. Quyền DUYỆT/từ chối
    // vẫn chỉ thuộc PM phụ trách (xem assertAssignedPm) — Account không được duyệt.
    private assertCanEditProductDescription(project: Projects, actor?: Actor) {
        if ([ProjectStatus.COMPLETED, ProjectStatus.CANCELLED].includes(project.status)) {
            throw this.httpError("Dự án đã hoàn tất hoặc đã đóng, không thể chỉnh sửa thông tin chuẩn sản phẩm", 400);
        }
        const actorUserId = this.getActorUserId(actor);
        const isAccount = this.isProjectAccount(project, actorUserId);
        const isAssignedPm = actor?.role === UserRole.PM && project.team?.members?.some((member) =>
            memberHasRole(member, MemberRole.PROJECT_MANAGER) &&
            member.user?.id === actorUserId
        );

        if (!isAccount && !isAssignedPm) {
            throw this.httpError("Chỉ Lead dự án (Account) hoặc PM phụ trách của dự án được nhập thông tin chuẩn sản phẩm", 403);
        }
    }

    private escapeHtml(text: string) {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    private textToHtml(text: string) {
        return text
            .split(/\n{2,}/)
            .map((paragraph) => paragraph.trim())
            .filter(Boolean)
            .map((paragraph) => `<p>${this.escapeHtml(paragraph).replace(/\n/g, "<br/>")}</p>`)
            .join("");
    }

    private async extractRawFileText(fileUrl: string): Promise<{ text: string | null; hasComplexLayout: boolean }> {
        const aiServiceUrl = assertAiServiceUrl();
        const formData = new URLSearchParams();
        formData.append("url", fileUrl);
        try {
            const response = await axios.post(`${aiServiceUrl}/documents/extract`, formData, {
                timeout: AI_SERVICE_REQUEST_TIMEOUT_MS,
                maxBodyLength: AI_SERVICE_MAX_FETCH_BYTES,
                maxContentLength: AI_SERVICE_MAX_FETCH_BYTES
            });
            return {
                text: response.data?.text ?? null,
                hasComplexLayout: Boolean(response.data?.has_complex_layout)
            };
        } catch (error: any) {
            const message = error?.response?.data?.detail || error?.message || "Không thể trích xuất nội dung file";
            throw this.httpError(message, 400);
        }
    }

    private async extractFileText(fileUrl: string): Promise<{ extractedText: string | null; hasComplexLayout: boolean }> {
        const { text, hasComplexLayout } = await this.extractRawFileText(fileUrl);
        return {
            extractedText: text ? this.textToHtml(text) : null,
            hasComplexLayout
        };
    }

    async extractForFile(projectId: string, fileUrl: string, actor?: Actor) {
        const project = await this.assertProjectAccess(projectId, actor);
        this.assertCanEditProductDescription(project, actor);

        const url = fileUrl?.trim();
        if (!url) {
            throw this.httpError("Vui lòng cung cấp fileUrl", 400);
        }

        const { extractedText, hasComplexLayout } = await this.extractFileText(url);
        return { extractedText, hasComplexLayout };
    }

    async aiFormat(projectId: string, text: string, productName?: string, actor?: Actor) {
        const project = await this.assertProjectAccess(projectId, actor);
        this.assertCanEditProductDescription(project, actor);

        const trimmed = text?.trim();
        if (!trimmed) {
            throw this.httpError("Vui lòng cung cấp nội dung để format", 400);
        }

        const aiServiceUrl = assertAiServiceUrl();
        try {
            const response = await axios.post(
                `${aiServiceUrl}/documents/format-product-info`,
                { text: trimmed, product_name: productName || null },
                {
                    timeout: AI_SERVICE_REQUEST_TIMEOUT_MS,
                    maxBodyLength: AI_SERVICE_MAX_FETCH_BYTES,
                    maxContentLength: AI_SERVICE_MAX_FETCH_BYTES
                }
            );
            return { extractedText: response.data?.html ?? "" };
        } catch (error: any) {
            const message = error?.response?.data?.detail || error?.message || "Không thể format nội dung";
            throw this.httpError(message, 400);
        }
    }

    private async validateItems(rawItems?: ProductDescriptionItemInput[]) {
        if (!Array.isArray(rawItems) || rawItems.length === 0) {
            throw this.httpError("Vui lòng thêm ít nhất một sản phẩm", 400);
        }

        const results = [];
        for (let index = 0; index < rawItems.length; index++) {
            const item = rawItems[index];
            const productName = item.productName?.trim();

            if (!productName) {
                throw this.httpError(`Vui lòng nhập tên sản phẩm ở dòng ${index + 1}`, 400);
            }

            const fileUrl = item.fileUrl?.trim() || "";
            if (!fileUrl) {
                throw this.httpError(`Vui lòng upload file thông tin chuẩn (doc/pdf) cho sản phẩm ${productName}`, 400);
            }

            const fileName = item.fileName?.trim() || null;
            const note = item.note?.trim() || null;
            const providedExtractedText = typeof item.extractedText === "string" ? item.extractedText.trim() : "";
            const extractedText = providedExtractedText
                ? providedExtractedText
                : (await this.extractFileText(fileUrl)).extractedText;
            const documents = Array.isArray(item.documents)
                ? item.documents
                    .filter((doc) => doc?.url?.trim())
                    .map((doc) => ({ url: doc.url!.trim(), name: doc.name?.trim() || null }))
                : [];

            results.push({
                id: item.id || null,
                productName,
                fileUrl,
                fileName,
                extractedText,
                note,
                documents
            });
        }

        return results;
    }

    private async findSubmissionForProject(projectId: string, submissionId: string) {
        const submission = await this.submissionRepository.findOne({
            where: { id: submissionId, projectId },
            relations: ["project", "project.team", "project.team.members", "project.team.members.user", "createdBy", "reviewedBy", "items"]
        });

        if (!submission) throw this.httpError("Không tìm thấy bản thông tin chuẩn sản phẩm", 404);
        return submission;
    }

    private assertEditableSubmission(submission: ProjectProductDescriptionSubmissions, actor: Actor) {
        this.getActorUserId(actor);
        if (![ProjectProductDescriptionStatus.DRAFT, ProjectProductDescriptionStatus.REJECTED].includes(submission.status)) {
            throw this.httpError("Chỉ có thể chỉnh sửa bản nháp hoặc bản không được duyệt", 400);
        }
    }

    // Không dùng project.team.members: assertProjectAccess áp bộ lọc RBAC theo người thao tác lên
    // chính quan hệ này, nên với Account/nhân sự nó chỉ còn đúng dòng của người đó (không có PM).
    // Vì vậy phải truy vấn danh sách PM trực tiếp theo team.
    private async getProjectManagers(project: Projects) {
        const teamId = project.team?.id;
        if (!teamId) return [];
        const members = await this.teamMemberRepository.find({
            where: SecurityService.withTenant({ team: { id: teamId }, roles: { role: MemberRole.PROJECT_MANAGER } }),
            relations: ["user"]
        });
        const recipients = members.filter(member => member.user).map(member => member.user);
        return Array.from(new Map(recipients.map(user => [user.id, user])).values());
    }

    private async notifyProjectManagers(project: Projects, data: {
        title: string;
        content: string;
        type: string;
        relatedEntityId?: string;
    }, excludeUserId?: string) {
        const managers = await this.getProjectManagers(project);
        if (managers.length === 0) {
            console.warn(`[ProductDescription] Dự án ${project.id} không có thành viên team nào mang role PROJECT_MANAGER, không gửi được thông báo.`);
            return;
        }
        const recipients = managers.filter(recipient => !(excludeUserId && recipient.id === excludeUserId));
        if (recipients.length === 0) {
            console.warn(`[ProductDescription] PM duy nhất của dự án ${project.id} chính là người gửi, không có ai nhận thông báo.`);
            return;
        }
        for (const recipient of recipients) {
            await this.notificationService.createNotification({
                title: data.title,
                content: data.content,
                type: data.type,
                recipient,
                relatedEntityId: data.relatedEntityId,
                relatedEntityType: "ProjectProductDescription",
                link: `/projects/${project.id}`
            });
        }
    }

    private async notifyUser(user: Users | null | undefined, project: Projects, data: {
        title: string;
        content: string;
        type: string;
        relatedEntityId?: string;
    }) {
        if (!user) return;
        await this.notificationService.createNotification({
            title: data.title,
            content: data.content,
            type: data.type,
            recipient: user,
            relatedEntityId: data.relatedEntityId,
            relatedEntityType: "ProjectProductDescription",
            link: `/projects/${project.id}`
        });
    }

    private async syncItems(submissionId: string, items: Awaited<ReturnType<ProjectProductDescriptionService["validateItems"]>>) {
        const existingItems = await this.itemRepository.query(
            `SELECT "id" FROM "project_product_description_items" WHERE "submissionId" = $1`,
            [submissionId]
        );
        const existingIds = new Set<string>(existingItems.map((item: { id: string }) => item.id));
        const keptIds = new Set<string>();

        for (const item of items) {
            if (item.id && existingIds.has(item.id)) {
                keptIds.add(item.id);
                await this.itemRepository.query(
                    `UPDATE "project_product_description_items"
                     SET "productName" = $1, "fileUrl" = $2, "fileName" = $3, "extractedText" = $4, "note" = $5, "documents" = $6, "updatedAt" = NOW()
                     WHERE "id" = $7 AND "submissionId" = $8`,
                    [
                        item.productName,
                        item.fileUrl,
                        item.fileName,
                        item.extractedText,
                        item.note,
                        JSON.stringify(item.documents || []),
                        item.id,
                        submissionId
                    ]
                );
                continue;
            }

            const newId = ulid();
            keptIds.add(newId);
            await this.itemRepository.query(
                `INSERT INTO "project_product_description_items"
                    ("id", "productName", "fileUrl", "fileName", "extractedText", "note", "documents", "submissionId")
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    newId,
                    item.productName,
                    item.fileUrl,
                    item.fileName,
                    item.extractedText,
                    item.note,
                    JSON.stringify(item.documents || []),
                    submissionId
                ]
            );
        }

        const deletedIds = [...existingIds].filter((id) => !keptIds.has(id));
        if (deletedIds.length > 0) {
            const placeholders = deletedIds.map((_, index) => `$${index + 2}`).join(", ");
            await this.itemRepository.query(
                `DELETE FROM "project_product_description_items" WHERE "submissionId" = $1 AND "id" IN (${placeholders})`,
                [submissionId, ...deletedIds]
            );
        }
    }

    private async countItems(submissionId: string) {
        const result = await this.itemRepository.query(
            `SELECT COUNT(*)::int AS count FROM "project_product_description_items" WHERE "submissionId" = $1`,
            [submissionId]
        );

        return Number(result?.[0]?.count || 0);
    }

    async getByProject(projectId: string, actor?: Actor) {
        await this.assertProjectAccess(projectId, actor);

        return this.submissionRepository.find({
            where: { projectId },
            relations: ["createdBy", "reviewedBy", "items"],
            order: {
                versionNumber: "DESC",
                createdAt: "DESC"
            }
        });
    }

    async create(projectId: string, payload: ProductDescriptionPayload, actor?: Actor) {
        const actorUserId = this.getActorUserId(actor);
        const project = await this.assertProjectAccess(projectId, actor);
        this.assertCanEditProductDescription(project, actor);
        const createdBy = await this.userRepository.findOneBy({ id: actorUserId });
        if (!createdBy) throw this.httpError("Không tìm thấy người tạo", 404);

        const items = await this.validateItems(payload.items);
        const submission = this.submissionRepository.create({
            project,
            projectId: project.id,
            status: ProjectProductDescriptionStatus.DRAFT,
            versionNumber: null as any,
            createdBy,
            createdById: createdBy.id,
            reviewedBy: null as any,
            reviewedById: null as any,
            reviewedAt: null as any,
            reviewNote: null as any
        });

        const saved = await this.submissionRepository.save(submission);
        await this.syncItems(saved.id, items);

        return this.findSubmissionForProject(projectId, saved.id);
    }

    async update(projectId: string, submissionId: string, payload: ProductDescriptionPayload, actor?: Actor) {
        const project = await this.assertProjectAccess(projectId, actor);
        this.assertCanEditProductDescription(project, actor);
        const submission = await this.findSubmissionForProject(projectId, submissionId);
        this.assertEditableSubmission(submission, actor as Actor);

        const items = await this.validateItems(payload.items);
        await this.syncItems(submission.id, items);

        submission.status = ProjectProductDescriptionStatus.DRAFT;
        submission.reviewedBy = null as any;
        submission.reviewedById = null as any;
        submission.reviewedAt = null as any;
        submission.reviewNote = null as any;
        await this.submissionRepository.save(submission);

        return this.findSubmissionForProject(projectId, submission.id);
    }

    async submit(projectId: string, submissionId: string, payload: ProductDescriptionPayload = {}, actor?: Actor) {
        const project = await this.assertProjectAccess(projectId, actor);
        this.assertCanEditProductDescription(project, actor);
        const submission = await this.findSubmissionForProject(projectId, submissionId);
        this.assertEditableSubmission(submission, actor as Actor);

        if (Array.isArray(payload.items)) {
            const items = await this.validateItems(payload.items);
            await this.syncItems(submission.id, items);
        }

        const itemCount = await this.countItems(submission.id);

        if (itemCount === 0) {
            throw this.httpError("Vui lòng thêm ít nhất một sản phẩm trước khi gửi duyệt", 400);
        }

        submission.status = ProjectProductDescriptionStatus.PENDING_REVIEW;
        submission.reviewedBy = null as any;
        submission.reviewedById = null as any;
        submission.reviewedAt = null as any;
        submission.reviewNote = null as any;
        await this.submissionRepository.save(submission);

        await this.notifyProjectManagers(project, {
            title: "Thông tin chuẩn sản phẩm chờ duyệt",
            content: `Dự án "${project.name}" có bản thông tin chuẩn sản phẩm mới cần PM duyệt.`,
            type: "PRODUCT_DESCRIPTION_SUBMITTED",
            relatedEntityId: submission.id
        }, this.getActorUserId(actor));

        return this.findSubmissionForProject(projectId, submission.id);
    }

    async approve(projectId: string, submissionId: string, actor?: Actor) {
        const project = await this.assertProjectAccess(projectId, actor);
        if ([ProjectStatus.COMPLETED, ProjectStatus.CANCELLED].includes(project.status)) {
            throw this.httpError("Dự án đã hoàn tất hoặc đã đóng, không thể duyệt thông tin chuẩn sản phẩm", 400);
        }
        this.assertAssignedPm(project, actor);
        const actorUserId = this.getActorUserId(actor);
        const reviewer = await this.userRepository.findOneBy({ id: actorUserId });
        if (!reviewer) throw this.httpError("Không tìm thấy người duyệt", 404);

        const submission = await this.findSubmissionForProject(projectId, submissionId);
        if (submission.status !== ProjectProductDescriptionStatus.PENDING_REVIEW) {
            throw this.httpError("Chỉ có thể duyệt bản đang chờ review", 400);
        }

        const maxResult = await this.submissionRepository
            .createQueryBuilder("submission")
            .select("MAX(submission.versionNumber)", "max")
            .where("submission.projectId = :projectId", { projectId })
            .andWhere("submission.status = :status", { status: ProjectProductDescriptionStatus.APPROVED })
            .getRawOne<{ max: string | number | null }>();

        submission.status = ProjectProductDescriptionStatus.APPROVED;
        submission.versionNumber = Number(maxResult?.max || 0) + 1;
        submission.reviewedBy = reviewer;
        submission.reviewedById = reviewer.id;
        submission.reviewedAt = new Date();
        submission.reviewNote = null as any;
        await this.submissionRepository.save(submission);

        await this.notifyUser(submission.createdBy, project, {
            title: "Thông tin chuẩn sản phẩm đã được duyệt",
            content: `Bản thông tin chuẩn sản phẩm của dự án "${project.name}" đã được duyệt phiên bản ${submission.versionNumber}.`,
            type: "PRODUCT_DESCRIPTION_APPROVED",
            relatedEntityId: submission.id
        });

        return this.findSubmissionForProject(projectId, submission.id);
    }

    async reject(projectId: string, submissionId: string, payload: ProductDescriptionPayload, actor?: Actor) {
        const project = await this.assertProjectAccess(projectId, actor);
        if ([ProjectStatus.COMPLETED, ProjectStatus.CANCELLED].includes(project.status)) {
            throw this.httpError("Dự án đã hoàn tất hoặc đã đóng, không thể duyệt thông tin chuẩn sản phẩm", 400);
        }
        this.assertAssignedPm(project, actor);
        const actorUserId = this.getActorUserId(actor);
        const reviewer = await this.userRepository.findOneBy({ id: actorUserId });
        if (!reviewer) throw this.httpError("Không tìm thấy người duyệt", 404);

        const submission = await this.findSubmissionForProject(projectId, submissionId);
        if (submission.status !== ProjectProductDescriptionStatus.PENDING_REVIEW) {
            throw this.httpError("Chỉ có thể không duyệt bản đang chờ review", 400);
        }

        submission.status = ProjectProductDescriptionStatus.REJECTED;
        submission.versionNumber = null as any;
        submission.reviewedBy = reviewer;
        submission.reviewedById = reviewer.id;
        submission.reviewedAt = new Date();
        submission.reviewNote = payload.reviewNote?.trim() || null as any;
        await this.submissionRepository.save(submission);

        await this.notifyUser(submission.createdBy, project, {
            title: "Thông tin chuẩn sản phẩm không được duyệt",
            content: `Bản thông tin chuẩn sản phẩm của dự án "${project.name}" không được duyệt${submission.reviewNote ? `: ${submission.reviewNote}` : "."}`,
            type: "PRODUCT_DESCRIPTION_REJECTED",
            relatedEntityId: submission.id
        });

        return this.findSubmissionForProject(projectId, submission.id);
    }
}