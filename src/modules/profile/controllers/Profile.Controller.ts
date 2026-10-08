import { Request, Response } from "express";
import { ProfileService } from "../services/Profile.Service";

export class ProfileController {
    private profileService = new ProfileService();

    getMe = async (req: Request, res: Response) => {
        try {
            const accountId = (req as any).user.id;
            const result = await this.profileService.getProfile(accountId);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(500).json({ message: error.message });
        }
    }

    updateMe = async (req: Request, res: Response) => {
        try {
            const accountId = (req as any).user.id;
            const result = await this.profileService.updateProfile(accountId, req.body);
            res.status(200).json({
                message: "Cập nhật thông tin cá nhân thành công",
                profile: result
            });
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }
}
