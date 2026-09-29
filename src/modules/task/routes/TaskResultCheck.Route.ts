import { Router } from "express";
import { TaskResultCheckController } from "../controllers/TaskResultCheck.Controller";

const router = Router();
const controller = new TaskResultCheckController();

router.get("/task/:taskId", controller.get);
router.patch("/task/:taskId/toggle", controller.toggle);
router.patch("/task/:taskId/toggle-bulk", controller.toggleBulk);
router.patch("/task/:taskId/rerun", controller.rerun);
router.get("/task/:taskId/preview", controller.preview);
router.post("/task/:taskId/finalize", controller.finalize);
router.get("/task/:taskId/pdf", controller.pdf);
router.get("/task/:taskId/xlsx", controller.xlsx);

export default router;
