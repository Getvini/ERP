import { Router } from "express";
import { TftController } from "../controllers/Tft.Controller";

const router = Router();
const c = new TftController();

router.get("/me", c.me);
router.get("/leaderboard", c.leaderboard);

export default router;
