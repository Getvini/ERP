import { Router } from "express";
import multer from "multer";
import os from "os";
import { ProjectController } from "../controllers/Project.Controller";
import { validationMiddleware } from "../../../shared/middlewares/Validation.Middleware";
import {
    AssignTeamDTO,
    PauseProjectDTO,
    RejectPauseDTO,
    ResumeProjectDTO,
    CloseProjectDTO,
    CloseProjectDirectDTO,
    RejectCloseDTO,
    UpdateProjectStatusDTO,
    UpdateWorkingFilesDTO,
    UpdateProjectDTO,
} from "../dto/Project.dto";
import { roleMiddleware } from "../../../shared/middlewares/Role.Middleware";


const router = Router();
const projectController = new ProjectController();

router.get("/", projectController.getAll);
router.get("/contract/:contractId", projectController.getByContract);
router.get("/my-projects", projectController.getMyProjects);
router.get("/:id/monthly-work-template", projectController.getMonthlyWorkTemplate);

router.post("/:id/pause", validationMiddleware(PauseProjectDTO), projectController.requestPause);
router.post(
    "/:id/pause/direct",
    roleMiddleware(["BOD", "ADMIN"]),
    validationMiddleware(PauseProjectDTO),
    projectController.pauseDirect
);
router.post(
    "/:id/resume",
    validationMiddleware(ResumeProjectDTO),
    projectController.resume
);
router.get("/:id/pause-history", projectController.getPauseHistory);
router.get("/:id/hold-summary", projectController.getHoldSummary);

// ── Đóng dự án ───────────────────────────────────────────────────────────
// BD/BOD/ADMIN đóng TRỰC TIẾP (không cần duyệt) — PM KHÔNG có quyền này.
// Quyền check thật nằm trong service (BD phải phụ trách hợp đồng).
router.post(
    "/:id/close/direct",
    roleMiddleware(["BD", "BOD", "ADMIN"]),
    validationMiddleware(CloseProjectDirectDTO),
    projectController.closeDirect
);
// PM đề nghị đóng → chờ BOD duyệt
router.post(
    "/:id/close",
    validationMiddleware(CloseProjectDTO),
    projectController.requestClose
);

// Duyệt/từ chối đơn đóng — thao tác trên REQUEST
router.post(
    "/close-requests/:requestId/approve",
    roleMiddleware(["BOD", "ADMIN", "ADMIN_SALE"]),
    projectController.approveClose
);
router.post(
    "/close-requests/:requestId/reject",
    roleMiddleware(["BOD", "ADMIN", "ADMIN_SALE"]),
    validationMiddleware(RejectCloseDTO),
    projectController.rejectClose
);

// ── Đổi trạng thái dự án (bổ sung: mobile đang gọi route này) ─────────────
// ⚠️ Chặn ON_HOLD / PENDING_PAUSE_APPROVAL / COMPLETED / CANCELLED — phải đi qua
//    /pause hoặc /close. Kiểm tra nằm trong service.
router.patch(
    "/:id/status",
    roleMiddleware(["BOD", "ADMIN"]),
    validationMiddleware(UpdateProjectStatusDTO),
    projectController.updateStatus
);

// Duyệt/từ chối đơn tạm dừng — thao tác trên REQUEST, không phải trên project
router.post(
    "/pause-requests/:requestId/approve",
    roleMiddleware(["BOD", "ADMIN"]),
    projectController.approvePause
);
router.post(
    "/pause-requests/:requestId/reject",
    roleMiddleware(["BOD", "ADMIN"]),
    validationMiddleware(RejectPauseDTO),
    projectController.rejectPause
);


router.post("/assign", validationMiddleware(AssignTeamDTO), projectController.assign);
router.post("/:id/confirm", projectController.confirm);
router.put(
    "/:id",
    roleMiddleware(["ADMIN", "PM"]),
    validationMiddleware(UpdateProjectDTO),
    projectController.update
);
router.post("/:id/monthly-work-addendums", projectController.createMonthlyWorkAddendum);
router.post("/:id/service-addendums", projectController.createServiceAddendum);
// Chỉ để trích xuất text: nhận file thẳng từ trình duyệt, ghi tạm ra đĩa, xong là xoá.
const extractUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, os.tmpdir()),
        filename: (_req, _file, cb) => cb(null, `pd-extract-${Date.now()}-${Math.round(Math.random() * 1e9)}`)
    }),
    limits: { fileSize: 500 * 1024 * 1024, files: 1 }
});

router.get("/:id/product-descriptions", projectController.getProductDescriptions);
router.post("/:id/product-descriptions", projectController.createProductDescription);
router.post("/:id/product-descriptions/extract-file", projectController.extractProductDescriptionFile);
router.post("/:id/product-descriptions/extract-upload", extractUpload.single("file"), projectController.extractProductDescriptionUpload);
router.post("/:id/product-descriptions/ai-format", projectController.aiFormatProductDescription);
router.put("/:id/product-descriptions/:submissionId", projectController.updateProductDescription);
router.post("/:id/product-descriptions/:submissionId/submit", projectController.submitProductDescription);
router.post(
    "/:id/product-descriptions/:submissionId/approve",
    roleMiddleware(["PM"]),
    projectController.approveProductDescription
);
router.post(
    "/:id/product-descriptions/:submissionId/reject",
    roleMiddleware(["PM"]),
    projectController.rejectProductDescription
);
// Google Sheet integration is temporarily disabled.
// router.post(
//     "/:id/google-sheet/retry",
//     authMiddleware,
//     roleMiddleware(["BOD", "ADMIN", "PM"]),
//     projectController.retryGoogleSheet
// );
router.post(
    "/:id/sync-service-jobs",
    roleMiddleware(["ADMIN", "PM"]),
    projectController.syncServiceJobs
);
router.post("/:id/product-descriptions/extract-file", projectController.extractProductDescriptionFile);
router.post("/:id/product-descriptions/ai-format", projectController.aiFormatProductDescription);
router.post("/:id/request-staffing", projectController.requestStaffing);
router.patch("/:id/working-files", validationMiddleware(UpdateWorkingFilesDTO), projectController.updateWorkingFiles);
router.get("/:id", projectController.getOne);
// router.post("/:id/start", projectController.start);


export default router;
