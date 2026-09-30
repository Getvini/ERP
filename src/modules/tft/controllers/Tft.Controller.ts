import { Response } from "express";
import { AuthRequest } from "../../../shared/middlewares/Auth.Middleware";
import { TftService } from "../services/Tft.Service";

export class TftController {
    me = async (req: AuthRequest, res: Response) => {
        try { res.json(await TftService.stats(req.user!.id)); }
        catch (e: any) { res.status(500).json({ message: e.message }); }
    };
    leaderboard = async (_req: AuthRequest, res: Response) => {
        try { res.json(await TftService.leaderboard(20)); }
        catch (e: any) { res.status(500).json({ message: e.message }); }
    };
}
