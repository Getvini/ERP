import { Request, Response } from "express";
import { DashboardService } from "../services/Dashboard.Service";

export class DashboardController {
    private dashboardService = new DashboardService();

    getDashboardData = async (req: Request, res: Response) => {
        try {
            const userInfo = (req as any).user;
            if (!userInfo) {
                return res.status(401).json({ message: "Không xác định được danh tính người dùng" });
            }

            const { userId, month, year, projectId, mode, startMonth, endMonth } = req.query;

            const data = await this.dashboardService.getDashboardData(
                userInfo,
                userId ? (userId as string) : undefined,
                month ? Number(month) : undefined,
                year ? Number(year) : undefined,
                projectId ? (projectId as string) : undefined,
                mode ? (mode as "personal" | "management") : undefined,
                startMonth ? Number(startMonth) : undefined,
                endMonth ? Number(endMonth) : undefined
            );

            res.status(200).json(data);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }
}
