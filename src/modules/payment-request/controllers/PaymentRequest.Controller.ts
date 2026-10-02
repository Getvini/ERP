import { Request, Response } from "express";
import { PaymentRequestService } from "../services/PaymentRequest.Service";
import { AuthRequest } from "../../../shared/middlewares/Auth.Middleware";
import { uploadToCloudinary } from "../../../shared/helpers/cloudinary.helper";

export class PaymentRequestController {
    private service = new PaymentRequestService();

    // Upload file hóa đơn (ảnh hoặc PDF) trước khi tạo/cập nhật yêu cầu thanh toán.
    // Trả về metadata file (name, url, size, ...) để FE gắn vào invoiceImages/invoicePdfs.
    uploadInvoice = async (req: any, res: Response) => {
        try {
            const file = req.file as Express.Multer.File | undefined;
            if (!file) {
                return res.status(400).json({ message: "Vui lòng chọn file hóa đơn" });
            }

            const isImage = file.mimetype.startsWith("image/");
            const isPdf = file.mimetype === "application/pdf";
            if (!isImage && !isPdf) {
                return res.status(400).json({ message: "Chỉ chấp nhận file ảnh (jpg, png...) hoặc PDF" });
            }

            const uploaded = await uploadToCloudinary(file, "ERP/PAYMENT_REQUESTS/invoices");
            res.status(201).json({ ...uploaded, fileType: isPdf ? "PDF" : "IMAGE" });
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    create = async (req: AuthRequest, res: Response) => {
        try {
            const requesterId = req.user?.userId || req.user?.id as string;
            const result = await this.service.create(req.body, requesterId);
            res.status(201).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    getAll = async (req: AuthRequest, res: Response) => {
        try {
            const viewerId = req.user?.userId || req.user?.id;
            const viewer = viewerId ? { userId: viewerId, role: req.user?.role as string } : undefined;
            const result = await this.service.getAll(req.query as any, viewer);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(500).json({ message: error.message });
        }
    }

    getTotalDebt = async (req: AuthRequest, res: Response) => {
        try {
            const viewerId = req.user?.userId || req.user?.id;
            const viewer = viewerId ? { userId: viewerId, role: req.user?.role as string } : undefined;
            const result = await this.service.getTotalDebt(req.query as any, viewer);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(500).json({ message: error.message });
        }
    }

    getTaskSpent = async (req: Request, res: Response) => {
        try {
            const result = await this.service.getTaskSpent(req.params.taskId as string);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    getOne = async (req: AuthRequest, res: Response) => {
        try {
            const viewerId = req.user?.userId || req.user?.id;
            const viewer = viewerId ? { userId: viewerId, role: req.user?.role as string } : undefined;
            const result = await this.service.getOne(req.params.id as string, viewer);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(404).json({ message: error.message });
        }
    }

    update = async (req: Request, res: Response) => {
        try {
            const result = await this.service.update(req.params.id as string, req.body);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    // Gửi duyệt yêu cầu đang ở trạng thái nháp (áp dụng cho cả yêu cầu tự tạo cho vendor)
    submit = async (req: AuthRequest, res: Response) => {
        try {
            const requesterId = req.user?.userId || req.user?.id as string;
            const result = await this.service.submit(req.params.id as string, requesterId);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    // Người tạo bổ sung hồ sơ/nội dung khi yêu cầu đang ở trạng thái "Cần bổ sung" (giữ lại lịch sử)
    supplement = async (req: AuthRequest, res: Response) => {
        try {
            const requesterId = req.user?.userId || req.user?.id as string;
            const result = await this.service.supplement(req.params.id as string, req.body, requesterId);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    addInvoicePdf = async (req: Request, res: Response) => {
        try {
            const result = await this.service.addInvoicePdf(req.params.id as string, req.body);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    review = async (req: AuthRequest, res: Response) => {
        try {
            const { action, note } = req.body;
            const reviewerId = req.user?.userId || req.user?.id as string;
            const result = await this.service.review(req.params.id as string, action, note, reviewerId, req.user?.role as string);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    bodDecision = async (req: AuthRequest, res: Response) => {
        try {
            const { action, reason, confirmedDueDate } = req.body;
            const bodUserId = req.user?.userId || req.user?.id as string;
            const result = await this.service.bodDecision(req.params.id as string, action, reason, bodUserId, confirmedDueDate);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    pay = async (req: AuthRequest, res: Response) => {
        try {
            const payerId = req.user?.userId || req.user?.id as string;
            const result = await this.service.pay(req.params.id as string, req.body, payerId);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    uploadPaymentProof = async (req: Request, res: Response) => {
        try {
            const result = await this.service.uploadPaymentProof(req.params.id as string, req.body);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    cancel = async (req: AuthRequest, res: Response) => {
        try {
            const actorId = req.user?.userId || req.user?.id as string;
            const { reason } = req.body;
            const result = await this.service.cancel(req.params.id as string, actorId, req.user?.role as string, reason);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }

    delete = async (req: Request, res: Response) => {
        try {
            const result = await this.service.delete(req.params.id as string);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ message: error.message });
        }
    }
}
