import { Request, Response } from "express";
import { UserService } from "../services/User.Service";
import { uploadToCloudinary } from "../../../shared/helpers/cloudinary.helper";

export class UserController {
    private userService = new UserService();

    getAll = async (req: Request, res: Response) => {
        try {
            const result = await this.userService.getAll(req.query as any, (req as any).user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(500).json({ message: error.message });
        }
    }

    getOne = async (req: Request, res: Response) => {
        try {
            const result = await this.userService.getOne(req.params.id as string, (req as any).user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(404).json({ message: error.message });
        }
    }

    create = async (req: Request, res: Response) => {
        try {
            const result = await this.userService.create(req.body);
            res.status(201).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    update = async (req: Request, res: Response) => {
        try {
            const data = { ...req.body };
            
            // Handle file uploads if present
            if (req.files && Array.isArray(req.files) && req.files.length > 0) {
                const uploadPromises = (req.files as Express.Multer.File[]).map(file => 
                    uploadToCloudinary(file, "GETVINI/ERP/user/labor_contract")
                );
                const uploadedFiles = await Promise.all(uploadPromises);
                data.laborContract = uploadedFiles;
            } else if (req.body.laborContract === '[]' || req.body.laborContract === null || (Array.isArray(req.body.laborContract) && req.body.laborContract.length === 0)) {
                // Handle explicit clearing of contracts if sent as empty array, string '[]', or null
                data.laborContract = [];
            }

            const result = await this.userService.update(req.params.id as string, data, (req as any).user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    updateLaborContracts = async (req: Request, res: Response) => {
        try {
            const { laborContract } = req.body;
            const result = await this.userService.updateLaborContracts(req.params.id as string, laborContract, (req as any).user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    delete = async (req: Request, res: Response) => {
        try {
            const result = await this.userService.delete(req.params.id as string);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }
}
