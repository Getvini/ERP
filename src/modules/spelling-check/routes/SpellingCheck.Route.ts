import { Router } from "express";
import multer from "multer";
import { SpellingCheckController } from "../controllers/SpellingCheck.Controller";

const router = Router();
const controller = new SpellingCheckController();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024, files: 1 },
});

router.post("/sheets", upload.single("file"), controller.listSheets);
router.post("/sheets-from-url", controller.listSheetsFromUrl);
router.post("/preview-from-url", controller.previewFromUrl);
router.post("/preview", upload.single("file"), controller.preview);
router.post("/start", upload.single("file"), controller.start);
router.post("/start-from-url", controller.startFromUrl);
router.get("/:jobId", controller.getStatus);
router.get("/:jobId/pdf", controller.getPdf);
router.delete("/:jobId", controller.delete);

export default router;
