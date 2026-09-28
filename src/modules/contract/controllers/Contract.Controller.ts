import { Request, Response } from "express";
import { ContractService } from "../services/Contract.Service";
import { PaymentMilestoneService } from "../../payment-milestone/services/PaymentMilestone.Service";
import { uploadToCloudinary } from "../../../shared/helpers/cloudinary.helper";

const isHttpUrl = (value: string) => {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
};

const isAllowedProposalFile = (file: any) => {
    const fileName = typeof file?.name === "string" ? file.name.trim() : "";
    const format = typeof file?.format === "string" ? file.format.trim().toLowerCase() : "";

    return /\.(docx|pdf)$/i.test(fileName) && (!format || ["docx", "pdf"].includes(format));
};

const isAllowedSignedFile = (file: any) => {
    const fileName = typeof file?.name === "string" ? file.name.trim() : "";
    const format = typeof file?.format === "string" ? file.format.trim().toLowerCase() : "";

    return /\.pdf$/i.test(fileName) && (!format || format === "pdf");
};

export class ContractController {
    private contractService = new ContractService();
    private milestoneService = new PaymentMilestoneService();

    getAll = async (req: Request, res: Response) => {
        try {
            const userInfo = (req as any).user;
            const filters = req.query;
            const contracts = await this.contractService.getAll(filters, userInfo);
            res.status(200).json(contracts);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    getOne = async (req: Request, res: Response) => {
        try {
            const userInfo = (req as any).user;
            const contract = await this.contractService.getOne(req.params.id as string, userInfo);
            res.status(200).json(contract);
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
            const userInfo = (req as any).user;
            const contract = await this.contractService.create(req.body, userInfo);
            res.status(201).json(contract);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }

    updateServiceNickname = async (req: Request, res: Response) => {
        try {
            const userInfo = (req as any).user;
            const service = await this.contractService.updateServiceNickname(
                req.params.id as string,
                req.body.nickname,
                userInfo
            );
            res.status(200).json(service);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    delete = async (req: Request, res: Response) => {
        try {
            const result = await this.contractService.delete(req.params.id as string);
            res.status(200).json(result);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }


    uploadProposal = async (req: Request, res: Response) => {
        try {
            const { file, contractLink, quotationLink } = req.body;
            if (file && contractLink?.trim()) {
                return res.status(400).json({ message: "Chỉ được chọn upload file hoặc link hợp đồng" });
            }
            if (file && !isAllowedProposalFile(file)) {
                return res.status(400).json({ message: "Chỉ chấp nhận file hợp đồng định dạng .docx hoặc .pdf" });
            }
            const proposalUrl = file?.url || contractLink?.trim();

            if (!proposalUrl) {
                return res.status(400).json({ message: "Vui lòng tải file .docx/.pdf hoặc nhập link hợp đồng" });
            }
            if (!isHttpUrl(proposalUrl)) {
                return res.status(400).json({ message: "Link hợp đồng không hợp lệ" });
            }
            if (quotationLink?.trim() && !isHttpUrl(quotationLink.trim())) {
                return res.status(400).json({ message: "Link báo giá không hợp lệ" });
            }

            const userInfo = (req as any).user;
            const contract = await this.contractService.uploadProposal(
                req.params.id as string,
                proposalUrl,
                quotationLink,
                userInfo
            );
            res.status(200).json(contract);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }

    approveProposal = async (req: Request, res: Response) => {
        try {
            const contract = await this.contractService.approveProposal(req.params.id as string, (req as any).user);

            res.status(200).json(contract);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }

    rejectProposal = async (req: Request, res: Response) => {
        try {
            const { reason } = req.body;
            if (!reason) {
                return res.status(400).json({ message: "Vui lòng cung cấp lý do từ chối" });
            }
            const userInfo = (req as any).user;
            const contract = await this.contractService.rejectProposal(req.params.id as string, reason, userInfo);
            res.status(200).json(contract);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }

    uploadSigned = async (req: Request, res: Response) => {
        try {
            const { file } = req.body;
            if (!file) {
                return res.status(400).json({ message: "Không tìm thấy file metadata" });
            }
            if (!isAllowedSignedFile(file)) {
                return res.status(400).json({ message: "Chỉ chấp nhận file hợp đồng đã ký định dạng .pdf" });
            }
            if (!file.url || !isHttpUrl(file.url)) {
                return res.status(400).json({ message: "Link file hợp đồng đã ký không hợp lệ" });
            }

            const userInfo = (req as any).user;
            const contract = await this.contractService.uploadSigned(req.params.id as string, file, userInfo);
            res.status(200).json(contract);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    addMilestone = async (req: Request, res: Response) => {
        try {
            const body = {
                name: req.body.title || req.body.name,
                dueDate: req.body.dueDate,
                percentage: req.body.percentage,
                amount: req.body.amount,
                description: req.body.description
            };
            const result = await this.milestoneService.create({
                contractId: req.params.id as string,
                milestones: [body]
            });
            res.status(201).json(result[0] || result);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }

    updateMilestone = async (req: Request, res: Response) => {
        try {
            const body = {
                ...req.body,
                name: req.body.title || req.body.name
            };
            const milestone = await this.milestoneService.update(req.params.id as string, body);
            res.status(200).json(milestone);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }

    deleteMilestone = async (req: Request, res: Response) => {
        try {
            const result = await this.milestoneService.delete(req.params.id as string);
            res.status(200).json(result);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }
}
