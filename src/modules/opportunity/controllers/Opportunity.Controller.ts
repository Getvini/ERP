import { Request, Response } from "express";
import { OpportunityService } from "../services/Opportunity.Service";
import { AuthRequest } from "../../../shared/middlewares/Auth.Middleware";
import { uploadToCloudinary } from "../../../shared/helpers/cloudinary.helper";

export class OpportunityController {
    private opportunityService = new OpportunityService();

    getAll = async (req: Request, res: Response) => {
        try {
            const userInfo = (req as any).user;
            const filters = req.query;
            const result = await this.opportunityService.getAll(filters, userInfo);
            res.status(200).json(result);
        } catch (error: any) {
            if (error.message === "FORBIDDEN_ACCESS") {
                res.status(403).json({ message: "Bạn không có quyền truy cập danh sách này" });
            } else {
                res.status(500).json({ message: error.message });
            }
        }
    }

    getOne = async (req: Request, res: Response) => {
        try {
            const userInfo = (req as any).user;
            const id = req.params.id as string;
            const result = await this.opportunityService.getOne(id, userInfo);
            res.status(200).json(result);
        } catch (error: any) {
            if (error.message === "FORBIDDEN_ACCESS" || error.message.includes("không có quyền xem")) {
                res.status(403).json({ message: error.message });
            } else {
                res.status(404).json({ message: error.message });
            }
        }
    }

    create = async (req: Request, res: Response) => {
        try {
            const authReq = req as AuthRequest;
            const accountId = authReq.user?.id;

            // req.body should now be plain JSON including pre-uploaded attachments
            const { services, attachments, ...rest } = req.body;

            const result = await this.opportunityService.create({
                ...rest,
                services: services || [],
                attachments: attachments || []
            }, authReq.user);

            res.status(201).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    update = async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const result = await this.opportunityService.update(id, req.body);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    addCustomer = async (req: Request, res: Response) => {
        try {
            const authReq = req as AuthRequest;
            const id = req.params.id as string;
            const result = await this.opportunityService.addCustomer(id, req.body, authReq.user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    delete = async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const result = await this.opportunityService.delete(id);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    approve = async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const result = await this.opportunityService.approve(id);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    reject = async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const result = await this.opportunityService.reject(id, req.body.reason);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }
}
