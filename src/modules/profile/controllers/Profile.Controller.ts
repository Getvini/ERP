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

    getIdCardPhoto = async (req: Request, res: Response) => {
        try {
            const accountId = (req as any).user.id;
            const side = req.params.side as "front" | "back";
            if (side !== "front" && side !== "back") {
                return res.status(400).json({ message: "Tham số mặt ảnh không hợp lệ (front hoặc back)" });
            }
            const imageUrl = await this.profileService.getIdCardPhotoUrl(accountId, side);
            if (!imageUrl) {
                return res.status(404).json({ message: "Chưa có ảnh CCCD mặt này" });
            }
            const axios = require("axios");
            const response = await axios.get(imageUrl, { responseType: "stream" });
            res.setHeader("Content-Type", response.headers["content-type"] || "image/jpeg");
            res.setHeader("Cache-Control", "private, no-cache, no-store, must-revalidate");
            response.data.pipe(res);
        } catch (error: any) {
            res.status(500).json({ message: error.message });
        }
    }
}
