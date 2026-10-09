import { Request, Response } from "express";
import { VendorService } from "../services/Vendor.Service";
import { uploadToCloudinary } from "../../../shared/helpers/cloudinary.helper";

export class VendorController {
    private vendorService = new VendorService();

    getAll = async (req: Request, res: Response) => {
        try {
            const result = await this.vendorService.getAll();
            res.status(200).json(result);
        } catch (error: any) {
            res.status(500).json({ message: error.message });
        }
    }

    getOne = async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const result = await this.vendorService.getOne(id);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(404).json({ message: error.message });
        }
    }

    create = async (req: Request, res: Response) => {
        try {
            const result = await this.vendorService.create(req.body);
            res.status(201).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    update = async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const result = await this.vendorService.update(id, req.body);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    delete = async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const result = await this.vendorService.delete(id);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    addJob = async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const jobId = req.params.jobId as string;
            const result = await this.vendorService.addJob(id, jobId, req.body);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    removeJob = async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const jobId = req.params.jobId as string;
            const result = await this.vendorService.removeJob(id, jobId);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    getJobs = async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const result = await this.vendorService.getJobs(id);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    getByJob = async (req: Request, res: Response) => {
        try {
            const jobId = req.params.jobId as string;
            const result = await this.vendorService.getByJob(jobId);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }
}
