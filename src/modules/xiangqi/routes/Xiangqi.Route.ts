import { Router } from "express";
import { XiangqiController } from "../controllers/Xiangqi.Controller";

const router = Router();
const c = new XiangqiController();

router.get("/me", c.me);
router.get("/leaderboard", c.leaderboard);
router.get("/games/mine", c.myGames);
router.get("/games/:id", c.game);

export default router;
