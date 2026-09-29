import { Response } from "express";
import { AuthRequest } from "../../../shared/middlewares/Auth.Middleware";
import { SettingService } from "../services/Setting.Service";

export class SettingController {
    private service = new SettingService();

    getQc = async (_req: AuthRequest, res: Response) => {
        try {
            const config = await this.service.getQcConfig();
            res.status(200).json({ config, options: this.service.getQcOptions() });
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    updateQc = async (req: AuthRequest, res: Response) => {
        try {
            const { provider, verifyModel, reasoningEffort, maxBatch, maxContext } = req.body || {};
            const config = await this.service.updateQcConfig({ provider, verifyModel, reasoningEffort, maxBatch, maxContext }, req.user);
            res.status(200).json({ config, options: this.service.getQcOptions() });
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    getWorkloadNorms = async (_req: AuthRequest, res: Response) => {
        try {
            const norms = await this.service.getWorkloadNorms();
            res.status(200).json({ norms });
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    updateWorkloadNorms = async (req: AuthRequest, res: Response) => {
        try {
            const norms = await this.service.updateWorkloadNorms(req.body?.norms, req.user);
            res.status(200).json({ norms });
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };
}
