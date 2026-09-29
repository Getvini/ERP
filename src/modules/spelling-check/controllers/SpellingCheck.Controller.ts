import { Request, Response } from "express";
import { SpellingCheckService } from "../services/SpellingCheck.Service";
import { SheetPreviewService } from "../../../shared/services/SheetPreview.Service";

const ALLOWED_EXTENSIONS = [".txt", ".csv", ".xlsx", ".xlsm"];

export class SpellingCheckController {
    private service = new SpellingCheckService();

    listSheets = async (req: Request, res: Response) => {
        try {
            const file = (req as any).file;
            if (!file) {
                return res.status(400).json({ message: "Vui lòng chọn file" });
            }
            const result = await this.service.listSheets(file.buffer, file.originalname);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.response?.status || 500).json({ message: error.response?.data?.detail || error.message });
        }
    };

    listSheetsFromUrl = async (req: Request, res: Response) => {
        try {
            const { fileUrl, fileName } = req.body;
            if (!fileUrl || !fileName) {
                return res.status(400).json({ message: "Thiếu fileUrl hoặc fileName" });
            }
            const result = await this.service.listSheetsFromUrl(fileUrl, fileName);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || error.response?.status || 500).json({ message: error.response?.data?.detail || error.message });
        }
    };

    start = async (req: Request, res: Response) => {
        try {
            const file = (req as any).file;
            if (!file) {
                return res.status(400).json({ message: "Vui lòng chọn file để kiểm tra chính tả" });
            }
            const ext = "." + (file.originalname.split(".").pop() || "").toLowerCase();
            if (!ALLOWED_EXTENSIONS.includes(ext)) {
                return res.status(400).json({ message: `Định dạng ${ext} chưa được hỗ trợ kiểm tra chính tả` });
            }
            const { lang, sheetNames, whitelist, scenarioIds, regions } = req.body;
            const result = await this.service.start(file.buffer, file.originalname, lang, sheetNames, whitelist, scenarioIds, regions);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.response?.status || 500).json({ message: error.response?.data?.detail || error.message });
        }
    };

    startFromUrl = async (req: Request, res: Response) => {
        try {
            const { fileUrl, fileName, lang, sheetNames, whitelist, scenarioIds, regions } = req.body;
            if (!fileUrl || !fileName) {
                return res.status(400).json({ message: "Thiếu fileUrl hoặc fileName" });
            }
            const ext = "." + (fileName.split(".").pop() || "").toLowerCase();
            if (!ALLOWED_EXTENSIONS.includes(ext)) {
                return res.status(400).json({ message: `Định dạng ${ext} chưa được hỗ trợ kiểm tra chính tả` });
            }
            const result = await this.service.startFromUrl(fileUrl, fileName, lang, sheetNames, whitelist, scenarioIds, regions);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || error.response?.status || 500).json({ message: error.response?.data?.detail || error.message });
        }
    };

    previewFromUrl = async (req: Request, res: Response) => {
        try {
            const { fileUrl, fileName, sheet, rowStart, rowCount, colStart, colCount } = req.body;
            if (!fileUrl || !fileName) {
                return res.status(400).json({ message: "Thiếu fileUrl hoặc fileName" });
            }
            const ext = "." + (String(fileName).split(".").pop() || "").toLowerCase();
            if (![".xlsx", ".xlsm"].includes(ext)) {
                return res.status(400).json({ message: "Chỉ hỗ trợ xem trước file xlsx hoặc xlsm" });
            }
            const result = await SheetPreviewService.fromUrl(fileUrl, { sheet, rowStart, rowCount, colStart, colCount });
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || error.response?.status || 500).json({ message: error.response?.data?.detail || error.message });
        }
    };

    getStatus = async (req: Request, res: Response) => {
        try {
            const result = await this.service.getStatus(req.params.jobId as string);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || error.response?.status || 500).json({ message: error.message });
        }
    };

    getPdf = async (req: Request, res: Response) => {
        try {
            const stream = await this.service.getPdfStream(req.params.jobId as string);
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", `attachment; filename="spell_report_${req.params.jobId}.pdf"`);
            stream.pipe(res);
        } catch (error: any) {
            res.status(error.response?.status || 500).json({ message: "Không thể tải báo cáo PDF" });
        }
    };

    delete = async (req: Request, res: Response) => {
        try {
            const result = await this.service.delete(req.params.jobId as string);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.response?.status || 500).json({ message: error.message });
        }
    };
}
