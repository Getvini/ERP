import { Request, Response } from "express";
import { TaskResultCheckService } from "../services/TaskResultCheck.Service";

export class TaskResultCheckController {
    private service = new TaskResultCheckService();

    get = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const result = await this.service.getForTask(req.params.taskId as string, user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    toggle = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const { kind, itemId, confirmed } = req.body;
            const result = await this.service.toggleItem(req.params.taskId as string, kind, itemId, confirmed, user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    toggleBulk = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const { kind, itemIds, confirmed } = req.body;
            const ids = Array.isArray(itemIds) ? itemIds : [];
            const result = await this.service.toggleItems(req.params.taskId as string, kind, ids, confirmed, user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    rerun = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const kind = ["QC", "BOTH"].includes(req.body.kind) ? req.body.kind : "SPELL";
            const whitelist = Array.isArray(req.body.whitelist) ? req.body.whitelist : [];
            const scope = req.body.scope && typeof req.body.scope === "object" ? req.body.scope : null;
            const reviewerNote = typeof req.body.reviewerNote === "string" ? req.body.reviewerNote.trim().slice(0, 1000) : "";
            const qcOptions = { reviewerNote: reviewerNote || undefined, refresh: req.body.refresh === true };
            const result = await this.service.rerunCheck(req.params.taskId as string, kind, whitelist, user, scope, qcOptions);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    preview = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const { sheet, rowStart, rowCount, colStart, colCount } = req.query;
            const result = await this.service.getPreview(req.params.taskId as string, {
                sheet: typeof sheet === "string" ? sheet : undefined,
                rowStart: rowStart as string | undefined,
                rowCount: rowCount as string | undefined,
                colStart: colStart as string | undefined,
                colCount: colCount as string | undefined
            }, user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    finalize = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const result = await this.service.finalize(req.params.taskId as string, user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    pdf = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const buffer = await this.service.buildPdf(req.params.taskId as string, user);
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", `attachment; filename="task_${req.params.taskId}_check.pdf"`);
            res.send(buffer);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    xlsx = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const buffer = await this.service.buildXlsx(req.params.taskId as string, user);
            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            res.setHeader("Content-Disposition", `attachment; filename="task_${req.params.taskId}_check.xlsx"`);
            res.send(buffer);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };
}
