import { Request, Response } from "express";
import { KlingWebhookService } from "../services/KlingWebhook.Service";
import { VideoGenerationReconciliationService } from "../services/VideoGenerationReconciliation.Service";

export class KlingWebhookController {
    private reconciliationService = new VideoGenerationReconciliationService();

    callback = async (req: Request & { rawBody?: Buffer }, res: Response) => {
        const rawBody = req.rawBody;
        if (!rawBody) {
            return res.status(400).json({ message: "Thiếu raw callback body" });
        }

        const verified = KlingWebhookService.verifySignature(
            rawBody,
            req.header("webhook-id") || undefined,
            req.header("webhook-timestamp") || undefined,
            req.header("webhook-signature") || undefined,
        );
        if (!verified) {
            return res.status(401).json({ message: "Chữ ký callback Kling không hợp lệ" });
        }

        const payload = req.body;
        const taskId = payload?.task_id || payload?.id;
        const taskStatus = payload?.task_status || payload?.status;
        if (!taskId || !taskStatus) {
            return res.status(400).json({ message: "Callback Kling không hợp lệ" });
        }

        try {
            // Callback test hoặc callback đến trước khi task được liên kết vẫn phải
            // nhận HTTP 200; cron sẽ đối soát lại bằng external task id.
            const handled = payload.task_id
                ? await this.reconciliationService.handleKlingCallback(payload)
                : false;
            return res.status(200).json({ received: true, handled });
        } catch (error: any) {
            console.error(`[KlingWebhook] ${error.message}`);
            return res.status(500).json({ message: "Không thể xử lý callback Kling" });
        }
    };
}
