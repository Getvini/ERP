import { createHmac, timingSafeEqual } from "crypto";

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export class KlingWebhookService {
    static getCallbackUrl(): string | undefined {
        if (!process.env.KLING_WEBHOOK_SECRET) return undefined;

        const configuredUrl = process.env.KLING_CALLBACK_URL?.trim();
        if (configuredUrl) return configuredUrl;

        const renderUrl = process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "");
        return renderUrl
            ? `${renderUrl}/api/video-generations/kling/callback`
            : undefined;
    }

    static verifySignature(
        rawBody: Buffer,
        webhookId: string | undefined,
        webhookTimestamp: string | undefined,
        webhookSignature: string | undefined,
    ): boolean {
        const secret = process.env.KLING_WEBHOOK_SECRET;
        if (!secret || !webhookId || !webhookTimestamp || !webhookSignature) return false;

        const timestamp = Number(webhookTimestamp);
        if (!Number.isFinite(timestamp)) return false;

        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

        try {
            const signingKey = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
            const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody.toString("utf8")}`;
            const expected = createHmac("sha256", signingKey)
                .update(signedContent, "utf8")
                .digest();

            return webhookSignature.split(/\s+/).some((versionedSignature) => {
                const [version, encodedSignature] = versionedSignature.split(",", 2);
                if (version !== "v1" || !encodedSignature) return false;

                const received = Buffer.from(encodedSignature, "base64");
                return received.length === expected.length && timingSafeEqual(received, expected);
            });
        } catch {
            return false;
        }
    }
}
