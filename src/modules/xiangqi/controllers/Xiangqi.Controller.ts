import { Response } from "express";
import { AuthRequest } from "../../../shared/middlewares/Auth.Middleware";
import { XiangqiService } from "../services/Xiangqi.Service";

export class XiangqiController {
    me = async (req: AuthRequest, res: Response) => {
        try {
            const id = req.user!.id;
            res.json({ ...(await XiangqiService.stats(id)), activeGame: XiangqiService.activeGameOf(id) });
        } catch (e: any) { res.status(500).json({ message: e.message }); }
    };
    leaderboard = async (_req: AuthRequest, res: Response) => {
        try { res.json(await XiangqiService.leaderboard(20)); }
        catch (e: any) { res.status(500).json({ message: e.message }); }
    };
    myGames = async (req: AuthRequest, res: Response) => {
        try { res.json(await XiangqiService.myGames(req.user!.id, 20)); }
        catch (e: any) { res.status(500).json({ message: e.message }); }
    };
    game = async (req: AuthRequest, res: Response) => {
        try {
            const g = await XiangqiService.gameById(String(req.params.id));
            if (!g) return res.status(404).json({ message: "Không tìm thấy ván đấu" });
            res.json(g);
        } catch (e: any) { res.status(500).json({ message: e.message }); }
    };
}
