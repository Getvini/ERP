import { Router } from "express";
import { KlingWebhookController } from "../controllers/KlingWebhook.Controller";

const router = Router();
const controller = new KlingWebhookController();

router.post("/callback", controller.callback);

export default router;
