export enum PerformerType {
    VENDOR = "VENDOR",
    INTERNAL = "INTERNAL"
}

export enum TaskStatus {
    PENDING = "PENDING",
    NOT_STARTED = "NOT_STARTED",
    DOING = "DOING",
    AWAITING_ACCEPTANCE = "AWAITING_ACCEPTANCE",
    INTERNAL_COMPLETED = "INTERNAL_COMPLETED",
    COMPLETED = "COMPLETED",
    ACCEPTED = "ACCEPTED",
    AWAITING_REVIEW = "AWAITING_REVIEW",
    REJECTED = "REJECTED",
    REJECTED_BILLABLE = "REJECTED_BILLABLE",
    REJECTED_SUPPORT = "REJECTED_SUPPORT",
    OVERDUE = "OVERDUE",
    AWAITING_PRICING = "AWAITING_PRICING",
    AWAITING_SUPPORT = "AWAITING_SUPPORT",
    REWORKING = "REWORKING",
    SUPPORT_PENDING = "SUPPORT_PENDING",
    SUPPORT_AWAITING_RETURN = "SUPPORT_AWAITING_RETURN",
    /**
     * Dự án đang tạm dừng — task bị khoá thao tác, chỉ xem.
     *
     * ⚠️ KHÔNG thêm giá trị này vào `activeStatuses` của cron task quá hạn
     * (`Cron.Helper.ts`) — task ON_HOLD không bao giờ được tự chuyển sang OVERDUE.
     */
    ON_HOLD = "ON_HOLD",
    /**
     * Task dở dang bị huỷ khi đóng dự án (khách không lấy nữa).
     * Không tính Vinicoin — luôn đi kèm `isRewardable = false`.
     */
    CANCELLED = "CANCELLED"
}

export enum SubtaskPlanStatus {
    DRAFT = "DRAFT",
    PENDING_APPROVAL = "PENDING_APPROVAL",
    APPROVED = "APPROVED"
}

export enum PricingStatus {
    PENDING = "PENDING",
    BILLABLE = "BILLABLE",
    NON_BILLABLE = "NON_BILLABLE"
}

export enum JobCategory {
    QUAY_PHIM = "QUAY_PHIM",
    DUNG_PHIM = "DUNG_PHIM",
    THIET_KE = "THIET_KE",
    AI_CONTENT = "AI_CONTENT",
    MARKETING = "MARKETING",
    BIEN_KICH = "BIEN_KICH",
    KHAC = "KHAC"
}

export enum JobLevel {
    A = "A",
    B = "B",
    C = "C"
}

export enum JobResponsibleRole {
    CONTENT_CREATOR = "CONTENT_CREATOR",
    EDITOR = "EDITOR",
    DESIGNER = "DESIGNER",
    CAMERAMAN = "CAMERAMAN",
    ACCOUNT = "ACCOUNT",
    VIDEO_EDITOR = "VIDEO_EDITOR",
    SOCIAL_MEDIA_MANAGER = "SOCIAL_MEDIA_MANAGER",
    PROJECT_MANAGER = "PROJECT_MANAGER"
}

export enum ViolationType {
    LATE_SUBMISSION = "LATE_SUBMISSION",
    LATE_UNFINISHED = "LATE_UNFINISHED",
    EXCESSIVE_REWORK = "EXCESSIVE_REWORK"
}
