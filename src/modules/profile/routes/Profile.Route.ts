import { Router } from "express";
import { ProfileController } from "../controllers/Profile.Controller";
import { authMiddleware } from "../../../shared/middlewares/Auth.Middleware";
import { writeRateLimitMiddleware } from "../../../shared/middlewares/RateLimit.Middleware";

const router = Router();
const profileController = new ProfileController();

router.use(authMiddleware);
router.use(writeRateLimitMiddleware);

router.get("/", profileController.getMe);
router.patch("/", profileController.updateMe);

export default router;
