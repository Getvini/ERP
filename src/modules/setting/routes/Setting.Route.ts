import { Router } from "express";
import { SettingController } from "../controllers/Setting.Controller";
import { roleMiddleware } from "../../../shared/middlewares/Role.Middleware";

const router = Router();
const controller = new SettingController();

router.get("/qc", roleMiddleware(["ADMIN"]), controller.getQc);
router.put("/qc", roleMiddleware(["ADMIN"]), controller.updateQc);
router.get("/workload-norms", roleMiddleware(["ADMIN"]), controller.getWorkloadNorms);
router.put("/workload-norms", roleMiddleware(["ADMIN"]), controller.updateWorkloadNorms);

export default router;
