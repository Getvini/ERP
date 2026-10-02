import { AppDataSource } from "../../../data-source";
import { EntityManager, In, IsNull } from "typeorm";
import {
    PaymentRequests,
    PaymentRequestType,
    PaymentRequestApprovalStatus,
    PaymentDueStatus,
    PaymentMethod,
    CashVoucherInfo,
    PaymentRequestFile,
    PaymentRequestHistoryEntry
} from "../entities/PaymentRequest.entity";
import { Tasks } from "../../task/entities/Task.entity";
import { Users } from "../../user/entities/User.entity";
import { UserRole } from "../../account/entities/Account.entity";
import { NotificationService } from "../../notification/services/Notification.Service";

const DUE_SOON_DAYS = 3;

// Vai trò duyệt vòng 1 (Admin Sale) + các vai trò luôn được coi là có quyền duyệt/xem toàn bộ
const REVIEWER_NOTIFY_ROLES: UserRole[] = [UserRole.ADMIN_SALE, UserRole.ADMIN];
const BOD_NOTIFY_ROLES: UserRole[] = [UserRole.BOD, UserRole.ADMIN];

export interface PaymentRequestQuery {
    search?: string;
    type?: PaymentRequestType;
    approvalStatus?: PaymentRequestApprovalStatus;
    paymentStatus?: PaymentDueStatus;
    projectId?: string;
    fromDate?: string;
    toDate?: string;
    dateField?: "dueDate" | "createdAt";
    minAmount?: number | string;
    maxAmount?: number | string;
    sortBy?: "createdAt" | "amount" | "dueDate";
    sortOrder?: "ASC" | "DESC";
}

export interface PaymentRequestViewer {
    userId: string;
    role: string;
}

// Vai trò được xem toàn bộ yêu cầu thanh toán (không giới hạn theo người tạo)
const FULL_VISIBILITY_ROLES: UserRole[] = [UserRole.ADMIN_SALE, UserRole.BOD, UserRole.ADMIN];

const canViewRequest = (request: PaymentRequests, viewer?: PaymentRequestViewer) => {
    if (!viewer) return true;
    if (FULL_VISIBILITY_ROLES.includes(viewer.role as UserRole)) return true;
    // Chi phí phát sinh do vendor: requesterId chính là người phân công task cho vendor
    // (xem createVendorExpense), nên chỉ cần so sánh requesterId là đủ để người phân công thấy.
    return request.requesterId === viewer.userId;
};

const computePaymentStatus = (request: PaymentRequests): PaymentDueStatus => {
    if (request.paidAt || request.paymentStatus === PaymentDueStatus.PAID) {
        return PaymentDueStatus.PAID;
    }

    if ([PaymentRequestApprovalStatus.REJECTED, PaymentRequestApprovalStatus.CANCELLED].includes(request.approvalStatus)) {
        return PaymentDueStatus.NOT_APPLICABLE;
    }

    if (request.approvalStatus !== PaymentRequestApprovalStatus.APPROVED) {
        return PaymentDueStatus.WAITING;
    }

    const effectiveDueDate = request.confirmedDueDate || request.dueDate;
    const dueDate = new Date(effectiveDueDate);
    const now = new Date();
    const diffDays = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return PaymentDueStatus.OVERDUE;
    if (diffDays <= DUE_SOON_DAYS) return PaymentDueStatus.DUE_SOON;
    return PaymentDueStatus.WAITING;
};

const REVIEWER_ROLES: UserRole[] = [UserRole.ADMIN_SALE];

// Bỏ qua giá trị `type` không còn hợp lệ (vd client cũ còn gửi VENDOR_EXPENSE) để không văng lỗi enum của Postgres.
const isValidRequestType = (value: unknown): value is PaymentRequestType =>
    Object.values(PaymentRequestType).includes(value as PaymentRequestType);

export class PaymentRequestService {
    private repo = AppDataSource.getRepository(PaymentRequests);
    private taskRepo = AppDataSource.getRepository(Tasks);
    private userRepo = AppDataSource.getRepository(Users);
    private notificationService = new NotificationService();

    private relations = ["project", "task", "vendor", "requester", "reviewer", "confirmedDueDateBy", "submittedToBodBy", "bodDecisionBy"];

    // Thêm một dòng lịch sử vào yêu cầu thanh toán (không lưu DB ở đây, chỉ mutate object truyền vào)
    private pushHistory(request: PaymentRequests, entry: Omit<PaymentRequestHistoryEntry, "at">) {
        request.history = [...(request.history || []), { ...entry, at: new Date().toISOString() }];
    }

    // Gửi thông báo tới tất cả user có 1 trong các role chỉ định (dùng để báo cho các bên liên quan: Admin Sale, BOD...)
    private async notifyRoles(roles: UserRole[], data: {
        title: string;
        content: string;
        type: string;
        link?: string;
        relatedEntityId?: string;
        excludeUserId?: string;
    }, manager?: EntityManager) {
        const userRepo = manager ? manager.getRepository(Users) : this.userRepo;
        const users = await userRepo.find({ where: { accounts: { role: In(roles) } }, relations: ["accounts"] });
        for (const user of users) {
            if (data.excludeUserId && user.id === data.excludeUserId) continue;
            await this.notificationService.createNotification({
                title: data.title,
                content: data.content,
                type: data.type,
                recipient: user,
                relatedEntityId: data.relatedEntityId,
                relatedEntityType: "PaymentRequests",
                link: data.link
            }, manager);
        }
    }

    // Gửi thông báo tới 1 người dùng cụ thể (thường là người tạo yêu cầu)
    private async notifyUser(userId: string | null | undefined, data: {
        title: string;
        content: string;
        type: string;
        link?: string;
        relatedEntityId?: string;
    }, manager?: EntityManager) {
        if (!userId) return;
        const userRepo = manager ? manager.getRepository(Users) : this.userRepo;
        const user = await userRepo.findOne({ where: { id: userId } });
        if (!user) return;
        await this.notificationService.createNotification({
            title: data.title,
            content: data.content,
            type: data.type,
            recipient: user,
            relatedEntityId: data.relatedEntityId,
            relatedEntityType: "PaymentRequests",
            link: data.link
        }, manager);
    }

    async create(dto: any, requesterId: string) {
        if (!dto.type || !Object.values(PaymentRequestType).includes(dto.type)) {
            throw new Error("Loại thanh toán không hợp lệ");
        }

        if (!dto.content || !dto.content.trim()) {
            throw new Error("Vui lòng nhập nội dung yêu cầu thanh toán");
        }

        if (!dto.amount || Number(dto.amount) <= 0) {
            throw new Error("Vui lòng nhập số tiền thanh toán hợp lệ lớn hơn 0");
        }

        if (!dto.dueDate) {
            throw new Error("Vui lòng chọn thời hạn thanh toán");
        }

        const invoiceImages = dto.invoiceImages || [];
        const invoicePdfs = dto.invoicePdfs || [];
        if (invoiceImages.length === 0 && invoicePdfs.length === 0) {
            throw new Error("Vui lòng đính kèm ít nhất một file hóa đơn hoặc chứng từ");
        }

        const request = new PaymentRequests();
        request.type = dto.type;
        request.content = dto.content.trim();
        request.amount = dto.amount;
        request.dueDate = dto.dueDate;
        request.projectId = dto.projectId || null;
        request.taskId = dto.taskId || null;
        request.invoiceImages = invoiceImages;
        request.invoicePdfs = invoicePdfs;
        request.requesterId = requesterId;
        request.approvalStatus = PaymentRequestApprovalStatus.PENDING_REVIEWER;
        request.paymentStatus = PaymentDueStatus.WAITING;

        if (dto.type === PaymentRequestType.PROJECT) {
            if (!dto.projectId) {
                throw new Error("Vui lòng chọn dự án");
            }
            if (!dto.taskId) {
                throw new Error("Vui lòng chọn công việc thuộc dự án");
            }
            const task = await this.taskRepo.findOne({ where: { id: dto.taskId }, relations: ["project", "assignee"] });
            if (!task) {
                throw new Error("Không tìm thấy công việc");
            }
            if (!task.project || task.project.id !== dto.projectId) {
                throw new Error("Công việc không thuộc dự án đã chọn");
            }
            if (!task.assigneeId || task.assigneeId !== requesterId) {
                throw new Error("Công việc này không được giao cho bạn");
            }
            request.costPrice = task.cost;
        } else if (dto.type === PaymentRequestType.OTHER_WORK) {
            if (!dto.taskId) {
                throw new Error("Vui lòng chọn công việc không thuộc dự án");
            }
            const task = await this.taskRepo.findOne({ where: { id: dto.taskId }, relations: ["project", "assignee"] });
            if (!task) {
                throw new Error("Không tìm thấy công việc");
            }
            if (task.project) {
                throw new Error("Công việc đã chọn thuộc dự án, không phải công việc khác");
            }
            if (!task.assigneeId || task.assigneeId !== requesterId) {
                throw new Error("Công việc này không được giao cho bạn");
            }
            request.costPrice = task.cost;
        }

        this.pushHistory(request, {
            action: "CREATED",
            byId: requesterId,
            snapshot: {
                content: request.content,
                amount: request.amount,
                dueDate: request.dueDate,
                invoiceImages: request.invoiceImages,
                invoicePdfs: request.invoicePdfs
            }
        });

        const saved = await this.repo.save(request);

        // Thông báo cho các bên liên quan (Admin Sale/Admin) để duyệt vòng 1
        await this.notifyRoles(REVIEWER_NOTIFY_ROLES, {
            title: "Yêu cầu thanh toán mới",
            content: `Có yêu cầu thanh toán mới cần duyệt: ${saved.content} (${Number(saved.amount).toLocaleString("vi-VN")}đ)`,
            type: "PAYMENT_REQUEST_CREATED",
            relatedEntityId: saved.id,
            link: `/payment-requests/${saved.id}`,
            excludeUserId: requesterId
        });

        return saved;
    }

    /**
     * Cách khởi tạo riêng của yêu cầu "thuê vendor": tự động tạo khi một task được phân công cho vendor.
     * Đây vẫn là yêu cầu thanh toán loại PROJECT (gắn dự án + công việc), chỉ khác ở chỗ có vendorId và
     * isAutoGenerated = true. Thông tin được điền sẵn theo dự án/công việc/vendor; requester là người
     * thực hiện phân công (PM/Admin) vì vendor không phải tài khoản trong hệ thống. Yêu cầu tạo ở trạng
     * thái DRAFT để người phụ trách xem lại, bổ sung nội dung/hoá đơn trước khi gửi duyệt chính thức.
     */
    async createVendorExpense(data: {
        projectId: string;
        taskId: string;
        vendorId: string;
        vendorName: string;
        taskName: string;
        taskCode?: string | null;
        projectName?: string;
        amount: number;
        dueDate: Date;
        requesterId: string;
    }, manager?: EntityManager) {
        const repo = manager ? manager.getRepository(PaymentRequests) : this.repo;

        const request = repo.create({
            type: PaymentRequestType.PROJECT,
            content: `Chi phí phát sinh - Vendor ${data.vendorName} thực hiện công việc "${data.taskName}"${data.taskCode ? ` (Mã: ${data.taskCode})` : ""}${data.projectName ? ` - Dự án ${data.projectName}` : ""}`,
            amount: data.amount,
            costPrice: data.amount,
            dueDate: data.dueDate,
            projectId: data.projectId,
            taskId: data.taskId,
            vendorId: data.vendorId,
            isAutoGenerated: true,
            requesterId: data.requesterId,
            approvalStatus: PaymentRequestApprovalStatus.DRAFT,
            paymentStatus: PaymentDueStatus.WAITING,
            invoiceImages: [],
            invoicePdfs: []
        } as any) as unknown as PaymentRequests;

        this.pushHistory(request, {
            action: "CREATED",
            byId: data.requesterId,
            note: "Tự động tạo khi phân công công việc cho vendor",
            snapshot: {
                content: request.content,
                amount: request.amount,
                dueDate: request.dueDate,
                invoiceImages: [],
                invoicePdfs: []
            }
        });

        const saved = await repo.save(request);

        await this.notifyUser(data.requesterId, {
            title: "Đã tạo yêu cầu thanh toán chi phí phát sinh (vendor)",
            content: `Task "${data.taskName}" vừa được giao cho vendor ${data.vendorName}. Hệ thống đã tạo sẵn 1 yêu cầu thanh toán nháp, vui lòng kiểm tra và gửi duyệt.`,
            type: "PAYMENT_REQUEST_VENDOR_AUTO_CREATED",
            relatedEntityId: saved.id,
            link: `/payment-requests/${saved.id}`
        }, manager);

        return saved;
    }

    async getAll(query: PaymentRequestQuery, viewer?: PaymentRequestViewer) {
        const qb = this.repo.createQueryBuilder("pr")
            .leftJoinAndSelect("pr.project", "project")
            .leftJoinAndSelect("pr.task", "task")
            .leftJoinAndSelect("pr.vendor", "vendor")
            .leftJoinAndSelect("pr.requester", "requester")
            .leftJoinAndSelect("pr.reviewer", "reviewer")
            .leftJoinAndSelect("pr.bodDecisionBy", "bodDecisionBy");

        if (query.search) {
            qb.andWhere("pr.content ILIKE :search", { search: `%${query.search}%` });
        }
        if (isValidRequestType(query.type)) {
            qb.andWhere("pr.type = :type", { type: query.type });
        }
        if (query.approvalStatus) {
            qb.andWhere("pr.approvalStatus = :approvalStatus", { approvalStatus: query.approvalStatus });
        }
        if (query.projectId) {
            qb.andWhere("pr.projectId = :projectId", { projectId: query.projectId });
        }

        const dateCol = query.dateField === "createdAt" ? "pr.createdAt" : "COALESCE(pr.confirmedDueDate, pr.dueDate)";
        if (query.fromDate) {
            qb.andWhere(`${dateCol} >= :fromDate`, { fromDate: new Date(`${query.fromDate}T00:00:00.000`) });
        }
        if (query.toDate) {
            qb.andWhere(`${dateCol} <= :toDate`, { toDate: new Date(`${query.toDate}T23:59:59.999`) });
        }

        if (query.minAmount !== undefined && query.minAmount !== "" && !isNaN(Number(query.minAmount))) {
            qb.andWhere("pr.amount >= :minAmount", { minAmount: Number(query.minAmount) });
        }
        if (query.maxAmount !== undefined && query.maxAmount !== "" && !isNaN(Number(query.maxAmount))) {
            qb.andWhere("pr.amount <= :maxAmount", { maxAmount: Number(query.maxAmount) });
        }

        // Phân quyền hiển thị: chỉ Admin Sale/BOD/Admin thấy toàn bộ, còn lại chỉ thấy yêu cầu do
        // chính mình tạo (bao gồm cả chi phí phát sinh vendor vì requesterId là người phân công).
        if (viewer && !FULL_VISIBILITY_ROLES.includes(viewer.role as UserRole)) {
            qb.andWhere("pr.requesterId = :viewerId", { viewerId: viewer.userId });
        }

        const sortColumn = query.sortBy === "amount" ? "pr.amount" : query.sortBy === "dueDate" ? "pr.dueDate" : "pr.createdAt";
        const sortOrder = query.sortOrder === "ASC" ? "ASC" : "DESC";
        qb.orderBy(sortColumn, sortOrder);

        const results = await qb.getMany();

        const withComputedStatus = results.map((request) => {
            request.paymentStatus = computePaymentStatus(request);
            return request;
        });

        if (query.paymentStatus) {
            return withComputedStatus.filter((request) => request.paymentStatus === query.paymentStatus);
        }

        return withComputedStatus;
    }

    async getOne(id: string, viewer?: PaymentRequestViewer) {
        const request = await this.repo.findOne({ where: { id }, relations: this.relations });
        if (!request) throw new Error("Không tìm thấy yêu cầu thanh toán");
        if (!canViewRequest(request, viewer)) {
            throw new Error("Bạn không có quyền xem yêu cầu thanh toán này");
        }
        request.paymentStatus = computePaymentStatus(request);
        return request;
    }

    async update(id: string, dto: any) {
        const request = await this.getOne(id);

        if (dto.cashVoucherInfo !== undefined || dto.paymentMethod !== undefined) {
            if (dto.cashVoucherInfo !== undefined) request.cashVoucherInfo = dto.cashVoucherInfo;
            if (dto.paymentMethod !== undefined) request.paymentMethod = dto.paymentMethod;
            if (Object.keys(dto).every((k) => ["cashVoucherInfo", "paymentMethod"].includes(k))) {
                return await this.repo.save(request);
            }
        }

        if (request.approvalStatus === PaymentRequestApprovalStatus.NEED_MORE_DOCS) {
            throw new Error("Yêu cầu này đang cần bổ sung, vui lòng dùng chức năng bổ sung để giữ lại lịch sử");
        }

        if (request.approvalStatus !== PaymentRequestApprovalStatus.DRAFT) {
            throw new Error("Yêu cầu thanh toán đã được xử lý, không thể sửa nội dung");
        }

        // Yêu cầu thuê vendor (hệ thống tự tạo khi giao task cho vendor) gắn cố định với dự án/công việc/vendor:
        // chỉ cho sửa nội dung, số tiền, hạn, hoá đơn — không cho đổi loại, dự án hay công việc.
        const isVendorLinked = Boolean(request.vendorId);

        const editableFields = isVendorLinked
            ? ["content", "amount", "dueDate", "invoiceImages", "invoicePdfs"]
            : ["content", "amount", "dueDate", "projectId", "taskId", "invoiceImages", "invoicePdfs"];
        for (const field of editableFields) {
            if (dto[field] !== undefined) {
                (request as any)[field] = dto[field];
            }
        }

        if (dto.type !== undefined && !isVendorLinked) {
            if (!Object.values(PaymentRequestType).includes(dto.type)) {
                throw new Error("Loại thanh toán không hợp lệ");
            }
            request.type = dto.type;
        }

        if (request.type === PaymentRequestType.PROJECT) {
            if (!request.taskId) {
                throw new Error("Vui lòng chọn công việc thuộc dự án");
            }
            const task = await this.taskRepo.findOne({ where: { id: request.taskId }, relations: ["project", "vendor"] });
            if (!task) {
                throw new Error("Không tìm thấy công việc");
            }
            if (!task.project || task.project.id !== request.projectId) {
                throw new Error("Công việc không thuộc dự án đã chọn");
            }
            if (isVendorLinked) {
                // Người tạo là người phân công (không phải assignee) nên kiểm tra task vẫn đang giao đúng vendor này.
                if (task.vendor?.id !== request.vendorId) {
                    throw new Error("Công việc không còn được giao cho vendor này");
                }
            } else if (!task.assigneeId || task.assigneeId !== request.requesterId) {
                throw new Error("Công việc này không được giao cho bạn");
            }
            request.costPrice = task.cost;
        } else if (request.type === PaymentRequestType.OTHER_WORK && request.taskId) {
            const task = await this.taskRepo.findOne({ where: { id: request.taskId }, relations: ["project"] });
            if (!task) {
                throw new Error("Không tìm thấy công việc");
            }
            if (task.project) {
                throw new Error("Công việc đã chọn thuộc dự án, không phải công việc khác");
            }
            if (!task.assigneeId || task.assigneeId !== request.requesterId) {
                throw new Error("Công việc này không được giao cho bạn");
            }
            request.costPrice = task.cost;
        }

        return await this.repo.save(request);
    }

    /**
     * Gửi duyệt một yêu cầu đang ở trạng thái nháp (DRAFT) — áp dụng cho yêu cầu tự tạo thủ công
     * hoặc yêu cầu "chi phí phát sinh" mà hệ thống tự tạo khi phân công task cho vendor.
     */
    async submit(id: string, requesterId: string) {
        const request = await this.getOne(id);

        if (request.approvalStatus !== PaymentRequestApprovalStatus.DRAFT) {
            throw new Error("Chỉ có thể gửi duyệt yêu cầu đang ở trạng thái nháp");
        }
        if (request.requesterId !== requesterId) {
            throw new Error("Bạn không phải người tạo yêu cầu này");
        }

        request.approvalStatus = PaymentRequestApprovalStatus.PENDING_REVIEWER;
        this.pushHistory(request, { action: "SUBMITTED", byId: requesterId });
        const saved = await this.repo.save(request);

        await this.notifyRoles(REVIEWER_NOTIFY_ROLES, {
            title: "Yêu cầu thanh toán mới",
            content: `Có yêu cầu thanh toán mới cần duyệt: ${saved.content} (${Number(saved.amount).toLocaleString("vi-VN")}đ)`,
            type: "PAYMENT_REQUEST_CREATED",
            relatedEntityId: saved.id,
            link: `/payment-requests/${saved.id}`,
            excludeUserId: requesterId
        });

        return saved;
    }

    /**
     * Người tạo BỔ SUNG hồ sơ/nội dung khi yêu cầu đang ở trạng thái "Cần bổ sung" (NEED_MORE_DOCS).
     * Khác với update(): trạng thái TRƯỚC khi bổ sung (nội dung, số tiền, hạn, hoá đơn cũ) được lưu
     * lại vào `history` trước khi bị thay đổi, để không mất lịch sử các lần bổ sung.
     * File hoá đơn mới được CỘNG DỒN vào danh sách cũ thay vì ghi đè, trừ khi FE chủ động gửi danh sách đã gộp.
     */
    async supplement(id: string, dto: any, requesterId: string) {
        const request = await this.getOne(id);

        if (request.approvalStatus !== PaymentRequestApprovalStatus.NEED_MORE_DOCS) {
            throw new Error("Yêu cầu thanh toán không ở trạng thái cần bổ sung");
        }
        if (request.requesterId !== requesterId) {
            throw new Error("Bạn không phải người tạo yêu cầu này");
        }

        // Lưu lại trạng thái hiện tại vào lịch sử TRƯỚC khi ghi đè
        this.pushHistory(request, {
            action: "SUPPLEMENTED",
            byId: requesterId,
            note: dto.note || null,
            snapshot: {
                content: request.content,
                amount: request.amount,
                dueDate: request.dueDate,
                invoiceImages: request.invoiceImages,
                invoicePdfs: request.invoicePdfs
            }
        });

        if (dto.content !== undefined) request.content = dto.content;
        if (dto.amount !== undefined) request.amount = dto.amount;
        if (dto.dueDate !== undefined) request.dueDate = dto.dueDate;

        // Hoá đơn bổ sung: cộng dồn vào danh sách hiện có (không xoá hồ sơ cũ) trừ khi FE truyền cờ replace
        if (Array.isArray(dto.addInvoiceImages) && dto.addInvoiceImages.length) {
            request.invoiceImages = [...(request.invoiceImages || []), ...dto.addInvoiceImages];
        } else if (dto.invoiceImages !== undefined) {
            request.invoiceImages = dto.invoiceImages;
        }
        if (Array.isArray(dto.addInvoicePdfs) && dto.addInvoicePdfs.length) {
            request.invoicePdfs = [...(request.invoicePdfs || []), ...dto.addInvoicePdfs];
        } else if (dto.invoicePdfs !== undefined) {
            request.invoicePdfs = dto.invoicePdfs;
        }

        // Quay lại hàng chờ Admin Sale duyệt
        request.approvalStatus = PaymentRequestApprovalStatus.PENDING_REVIEWER;
        request.reviewNote = null;

        const saved = await this.repo.save(request);

        // Thông báo cho các bên duyệt là yêu cầu đã được bổ sung, cần xem lại
        await this.notifyRoles(REVIEWER_NOTIFY_ROLES, {
            title: "Yêu cầu thanh toán đã được bổ sung",
            content: `${saved.requester?.fullName || "Người tạo"} đã bổ sung hồ sơ cho yêu cầu: ${saved.content}. Vui lòng xem lại.`,
            type: "PAYMENT_REQUEST_SUPPLEMENTED",
            relatedEntityId: saved.id,
            link: `/payment-requests/${saved.id}`,
            excludeUserId: requesterId
        });

        // Nếu người duyệt vòng 1 trước đó đã yêu cầu bổ sung, báo riêng cho họ biết
        if (saved.reviewerId) {
            await this.notifyUser(saved.reviewerId, {
                title: "Yêu cầu thanh toán đã được bổ sung",
                content: `${saved.requester?.fullName || "Người tạo"} đã bổ sung hồ sơ cho yêu cầu: ${saved.content}. Vui lòng xem lại.`,
                type: "PAYMENT_REQUEST_SUPPLEMENTED",
                relatedEntityId: saved.id,
                link: `/payment-requests/${saved.id}`
            });
        }

        return saved;
    }

    async addInvoicePdf(id: string, file: PaymentRequestFile) {
        const request = await this.getOne(id);
        request.invoicePdfs = [...(request.invoicePdfs || []), { ...file, uploadedAt: new Date().toISOString() }];
        return await this.repo.save(request);
    }

    async review(id: string, action: "APPROVE" | "REJECT" | "REQUEST_MORE_DOCS", note: string, reviewerId: string, reviewerRole: string) {
        const request = await this.getOne(id);

        if (request.approvalStatus !== PaymentRequestApprovalStatus.PENDING_REVIEWER) {
            throw new Error("Yêu cầu thanh toán không ở trạng thái chờ duyệt");
        }

        const allowedRoles = REVIEWER_ROLES;
        if (!allowedRoles.includes(reviewerRole as UserRole) && ![UserRole.BOD, UserRole.ADMIN].includes(reviewerRole as UserRole)) {
            throw new Error("Bạn không có quyền duyệt yêu cầu thanh toán này");
        }

        if ((action === "REJECT" || action === "REQUEST_MORE_DOCS") && (!note || !note.trim())) {
            throw new Error("Vui lòng nhập lý do");
        }

        request.reviewerId = reviewerId;
        request.reviewedAt = new Date();
        request.reviewNote = note || null;

        if (action === "APPROVE") {
            request.approvalStatus = PaymentRequestApprovalStatus.PENDING_BOD;
            request.submittedToBodById = reviewerId;
            request.submittedToBodAt = new Date();
        } else if (action === "REJECT") {
            request.approvalStatus = PaymentRequestApprovalStatus.REJECTED;
        } else if (action === "REQUEST_MORE_DOCS") {
            request.approvalStatus = PaymentRequestApprovalStatus.NEED_MORE_DOCS;
        } else {
            throw new Error("Hành động không hợp lệ");
        }

        this.pushHistory(request, { action: "REVIEWED", byId: reviewerId, note: note || null });
        const saved = await this.repo.save(request);

        if (action === "APPROVE") {
            await this.notifyUser(saved.requesterId, {
                title: "Yêu cầu thanh toán được duyệt vòng 1",
                content: `Yêu cầu thanh toán "${saved.content}" đã được duyệt và trình BOD xác nhận.`,
                type: "PAYMENT_REQUEST_APPROVED_REVIEWER",
                relatedEntityId: saved.id,
                link: `/payment-requests/${saved.id}`
            });
            await this.notifyRoles(BOD_NOTIFY_ROLES, {
                title: "Yêu cầu thanh toán chờ xác nhận",
                content: `Yêu cầu thanh toán "${saved.content}" (${Number(saved.amount).toLocaleString("vi-VN")}đ) đang chờ BOD xác nhận.`,
                type: "PAYMENT_REQUEST_PENDING_BOD",
                relatedEntityId: saved.id,
                link: `/payment-requests/${saved.id}`
            });
        } else if (action === "REJECT") {
            await this.notifyUser(saved.requesterId, {
                title: "Yêu cầu thanh toán bị từ chối",
                content: `Yêu cầu thanh toán "${saved.content}" đã bị từ chối${note ? `: ${note}` : "."}`,
                type: "PAYMENT_REQUEST_REJECTED",
                relatedEntityId: saved.id,
                link: `/payment-requests/${saved.id}`
            });
        } else if (action === "REQUEST_MORE_DOCS") {
            await this.notifyUser(saved.requesterId, {
                title: "Yêu cầu thanh toán cần bổ sung",
                content: `Yêu cầu thanh toán "${saved.content}" cần bổ sung hồ sơ${note ? `: ${note}` : "."}`,
                type: "PAYMENT_REQUEST_NEED_MORE_DOCS",
                relatedEntityId: saved.id,
                link: `/payment-requests/${saved.id}`
            });
        }

        return saved;
    }

    async bodDecision(id: string, action: "APPROVE" | "REJECT" | "REQUEST_MORE_DOCS", reason: string, bodUserId: string, confirmedDueDate?: string) {
        const request = await this.getOne(id);

        if (request.approvalStatus !== PaymentRequestApprovalStatus.PENDING_BOD) {
            throw new Error("Yêu cầu thanh toán không ở trạng thái chờ BOD xác nhận");
        }

        request.bodDecisionById = bodUserId;
        request.bodDecisionAt = new Date();
        request.bodDecisionReason = reason || null;

        if (action === "APPROVE") {
            request.approvalStatus = PaymentRequestApprovalStatus.APPROVED;
            if (confirmedDueDate) {
                request.confirmedDueDate = new Date(confirmedDueDate) as any;
                request.confirmedDueDateById = bodUserId;
            }
            if (request.taskId) {
                const task = await this.taskRepo.findOne({ where: { id: request.taskId } });
                if (task) {
                    task.spentAmount = Number(task.spentAmount || 0) + Number(request.amount);
                    await this.taskRepo.save(task);
                }
            }
        } else if (action === "REJECT") {
            if (!reason || !reason.trim()) {
                throw new Error("Vui lòng nhập lý do từ chối");
            }
            request.approvalStatus = PaymentRequestApprovalStatus.REJECTED;
        } else if (action === "REQUEST_MORE_DOCS") {
            if (!reason || !reason.trim()) {
                throw new Error("Vui lòng nhập lý do yêu cầu bổ sung");
            }
            request.approvalStatus = PaymentRequestApprovalStatus.NEED_MORE_DOCS;
        } else {
            throw new Error("Hành động không hợp lệ");
        }

        request.paymentStatus = computePaymentStatus(request);
        this.pushHistory(request, { action: "BOD_DECISION", byId: bodUserId, note: reason || null });
        const saved = await this.repo.save(request);

        if (action === "APPROVE") {
            await this.notifyUser(saved.requesterId, {
                title: "Yêu cầu thanh toán đã được BOD xác nhận",
                content: `Yêu cầu thanh toán "${saved.content}" đã được BOD xác nhận, chờ chi tiền.`,
                type: "PAYMENT_REQUEST_APPROVED",
                relatedEntityId: saved.id,
                link: `/payment-requests/${saved.id}`
            });
            await this.notifyRoles([UserRole.ADMIN_SALE, UserRole.ADMIN], {
                title: "Yêu cầu thanh toán cần chi tiền",
                content: `Yêu cầu thanh toán "${saved.content}" (${Number(saved.amount).toLocaleString("vi-VN")}đ) đã được BOD duyệt, cần thực hiện chi tiền.`,
                type: "PAYMENT_REQUEST_READY_TO_PAY",
                relatedEntityId: saved.id,
                link: `/payment-requests/${saved.id}`
            });
        } else if (action === "REJECT") {
            await this.notifyUser(saved.requesterId, {
                title: "Yêu cầu thanh toán bị BOD từ chối",
                content: `Yêu cầu thanh toán "${saved.content}" đã bị BOD từ chối${reason ? `: ${reason}` : "."}`,
                type: "PAYMENT_REQUEST_REJECTED",
                relatedEntityId: saved.id,
                link: `/payment-requests/${saved.id}`
            });
        } else if (action === "REQUEST_MORE_DOCS") {
            await this.notifyUser(saved.requesterId, {
                title: "Yêu cầu thanh toán cần bổ sung",
                content: `Yêu cầu thanh toán "${saved.content}" bị BOD yêu cầu bổ sung hồ sơ${reason ? `: ${reason}` : "."}`,
                type: "PAYMENT_REQUEST_NEED_MORE_DOCS",
                relatedEntityId: saved.id,
                link: `/payment-requests/${saved.id}`
            });
        }

        return saved;
    }

    async pay(id: string, dto: {
        paymentMethod?: PaymentMethod;
        paymentProofs?: PaymentRequestFile[];
        cashVoucherInfo?: CashVoucherInfo;
    }, payerId?: string) {
        const request = await this.getOne(id);

        if (request.approvalStatus !== PaymentRequestApprovalStatus.APPROVED) {
            throw new Error("Yêu cầu thanh toán chưa được BOD xác nhận");
        }

        if (!Array.isArray(dto.paymentProofs) || dto.paymentProofs.length === 0) {
            throw new Error("Vui lòng tải lên ảnh/PDF minh chứng đã chi tiền");
        }

        if (dto.paymentMethod) {
            request.paymentMethod = dto.paymentMethod;
        }
        if (dto.cashVoucherInfo) {
            request.cashVoucherInfo = dto.cashVoucherInfo;
        }

        request.paymentProofs = dto.paymentProofs.map((file) => ({ ...file, uploadedAt: file.uploadedAt || new Date().toISOString() }));
        request.paidAt = new Date();
        request.paymentStatus = PaymentDueStatus.PAID;

        const historyNote = dto.paymentMethod === PaymentMethod.CASH
            ? `Chi tiền mặt (Phiếu chi: ${dto.cashVoucherInfo?.voucherNo || "N/A"})`
            : "Chi bằng chuyển khoản";

        this.pushHistory(request, { action: "PAID", byId: payerId || "system", note: historyNote });
        const saved = await this.repo.save(request);

        await this.notifyUser(saved.requesterId, {
            title: "Yêu cầu thanh toán đã được chi tiền",
            content: `Yêu cầu thanh toán "${saved.content}" đã được chi tiền thành công.`,
            type: "PAYMENT_REQUEST_PAID",
            relatedEntityId: saved.id,
            link: `/payment-requests/${saved.id}`
        });

        return saved;
    }

    async uploadPaymentProof(id: string, file: PaymentRequestFile) {
        const request = await this.getOne(id);
        request.paymentProofs = [...(request.paymentProofs || []), { ...file, uploadedAt: new Date().toISOString() }];
        return await this.repo.save(request);
    }

    async cancel(id: string, actorId: string, actorRole: string, reason?: string) {
        const request = await this.getOne(id);

        if (request.paidAt || request.paymentStatus === PaymentDueStatus.PAID) {
            throw new Error("Yêu cầu thanh toán đã được chi tiền, không thể hủy");
        }
        if (request.approvalStatus === PaymentRequestApprovalStatus.CANCELLED) {
            throw new Error("Yêu cầu thanh toán đã bị hủy trước đó");
        }
        if (request.approvalStatus === PaymentRequestApprovalStatus.REJECTED) {
            throw new Error("Yêu cầu thanh toán đã bị từ chối, không thể hủy");
        }

        const isBodOrAdmin = [UserRole.BOD, UserRole.ADMIN].includes(actorRole as UserRole);

        if (request.approvalStatus === PaymentRequestApprovalStatus.APPROVED) {
            if (!isBodOrAdmin) {
                throw new Error("Bạn không có quyền hủy yêu cầu thanh toán đã được duyệt");
            }
            if (!reason) {
                throw new Error("Vui lòng nhập lý do hủy");
            }
            if (request.taskId) {
                const task = await this.taskRepo.findOne({ where: { id: request.taskId } });
                if (task) {
                    task.spentAmount = Math.max(0, Number(task.spentAmount || 0) - Number(request.amount));
                    await this.taskRepo.save(task);
                }
            }
        } else {
            if (request.requesterId !== actorId && !isBodOrAdmin) {
                throw new Error("Bạn không phải người tạo yêu cầu này");
            }
        }

        request.approvalStatus = PaymentRequestApprovalStatus.CANCELLED;
        this.pushHistory(request, { action: "CANCELLED", byId: actorId, note: reason || null });
        const saved = await this.repo.save(request);

        await this.notifyUser(saved.requesterId, {
            title: "Yêu cầu thanh toán đã bị hủy",
            content: `Yêu cầu thanh toán "${saved.content}" đã bị hủy${reason ? `: ${reason}` : "."}`,
            type: "PAYMENT_REQUEST_CANCELLED",
            relatedEntityId: saved.id,
            link: `/payment-requests/${saved.id}`
        });

        if (saved.requesterId !== actorId) {
            await this.notifyRoles(REVIEWER_NOTIFY_ROLES, {
                title: "Yêu cầu thanh toán đã bị hủy",
                content: `Yêu cầu thanh toán "${saved.content}" đã bị hủy${reason ? `: ${reason}` : "."}`,
                type: "PAYMENT_REQUEST_CANCELLED",
                relatedEntityId: saved.id,
                link: `/payment-requests/${saved.id}`,
                excludeUserId: actorId
            });
        }

        return saved;
    }

    async cancelPendingForTask(taskId: string, actorId: string, manager?: EntityManager) {
        const repo = manager ? manager.getRepository(PaymentRequests) : this.repo;
        const taskRepo = manager ? manager.getRepository(Tasks) : this.taskRepo;

        const pending = await repo.find({
            where: {
                taskId,
                approvalStatus: In([
                    PaymentRequestApprovalStatus.DRAFT,
                    PaymentRequestApprovalStatus.PENDING_REVIEWER,
                    PaymentRequestApprovalStatus.NEED_MORE_DOCS,
                    PaymentRequestApprovalStatus.PENDING_BOD
                ])
            }
        });

        for (const request of pending) {
            request.approvalStatus = PaymentRequestApprovalStatus.CANCELLED;
            this.pushHistory(request, {
                action: "CANCELLED",
                byId: actorId,
                note: "Tự động hủy do công việc bị đổi phân công"
            });
            await repo.save(request);
        }

        const approvedUnpaid = await repo.find({
            where: {
                taskId,
                approvalStatus: PaymentRequestApprovalStatus.APPROVED,
                paidAt: IsNull()
            }
        });

        if (approvedUnpaid.length > 0) {
            throw new Error("Công việc này còn yêu cầu thanh toán đã được duyệt nhưng chưa chi tiền, vui lòng xử lý trước khi thay đổi phân công");
        }

        const task = await taskRepo.findOne({ where: { id: taskId } });
        return task;
    }

    async delete(id: string) {
        const request = await this.getOne(id);
        if (request.approvalStatus !== PaymentRequestApprovalStatus.DRAFT) {
            throw new Error("Chỉ xóa được yêu cầu thanh toán ở trạng thái nháp");
        }
        await this.repo.remove(request);
        return { message: "Đã xóa yêu cầu thanh toán" };
    }

    async getTaskSpent(taskId: string) {
        const task = await this.taskRepo.findOne({ where: { id: taskId } });
        if (!task) {
            throw new Error("Không tìm thấy công việc");
        }

        const cost = Number(task.cost || 0);
        const spentAmount = Number(task.spentAmount || 0);

        return {
            taskId,
            cost,
            spentAmount,
            remainingAmount: cost - spentAmount
        };
    }

    async getTotalDebt(query: PaymentRequestQuery, viewer?: PaymentRequestViewer) {
        const qb = this.repo.createQueryBuilder("pr")
            .where("pr.approvalStatus = :approved", { approved: PaymentRequestApprovalStatus.APPROVED })
            .andWhere("pr.paidAt IS NULL");

        if (query.search) {
            qb.andWhere("pr.content ILIKE :search", { search: `%${query.search}%` });
        }
        if (isValidRequestType(query.type)) {
            qb.andWhere("pr.type = :type", { type: query.type });
        }
        if (query.projectId) {
            qb.andWhere("pr.projectId = :projectId", { projectId: query.projectId });
        }

        const dateCol = query.dateField === "createdAt" ? "pr.createdAt" : "COALESCE(pr.confirmedDueDate, pr.dueDate)";
        if (query.fromDate) {
            qb.andWhere(`${dateCol} >= :fromDate`, { fromDate: new Date(`${query.fromDate}T00:00:00.000`) });
        }
        if (query.toDate) {
            qb.andWhere(`${dateCol} <= :toDate`, { toDate: new Date(`${query.toDate}T23:59:59.999`) });
        }

        if (query.minAmount !== undefined && query.minAmount !== "" && !isNaN(Number(query.minAmount))) {
            qb.andWhere("pr.amount >= :minAmount", { minAmount: Number(query.minAmount) });
        }
        if (query.maxAmount !== undefined && query.maxAmount !== "" && !isNaN(Number(query.maxAmount))) {
            qb.andWhere("pr.amount <= :maxAmount", { maxAmount: Number(query.maxAmount) });
        }

        if (viewer && !FULL_VISIBILITY_ROLES.includes(viewer.role as UserRole)) {
            qb.andWhere("pr.requesterId = :viewerId", { viewerId: viewer.userId });
        }

        const raw = await qb.select([
            "COALESCE(SUM(pr.amount), 0) AS total",
            "COALESCE(SUM(CASE WHEN pr.type = 'PROJECT' THEN pr.amount ELSE 0 END), 0) AS project_debt",
            "COALESCE(SUM(CASE WHEN pr.type = 'OTHER_WORK' THEN pr.amount ELSE 0 END), 0) AS other_work_debt"
        ]).getRawOne();

        return {
            totalDebt: Number(raw?.total || 0),
            projectDebt: Number(raw?.project_debt || 0),
            otherWorkDebt: Number(raw?.other_work_debt || 0)
        };
    }
}
