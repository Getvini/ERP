const rawUrl = process.env.AI_SERVICE_URL;
const trimmedUrl = rawUrl && rawUrl.trim() ? rawUrl.trim().replace(/\/$/, "") : "";

export const AI_SERVICE_URL = trimmedUrl;

export const isAiServiceConfigured = Boolean(trimmedUrl);

export function assertAiServiceUrl(): string {
    if (!trimmedUrl) {
        const error = new Error("Chức năng này cần AI service nhưng hệ thống chưa cấu hình AI_SERVICE_URL") as Error & { statusCode?: number };
        error.statusCode = 503;
        throw error;
    }
    return trimmedUrl;
}

export const AI_SERVICE_MAX_FETCH_BYTES = 500 * 1024 * 1024;

// Đọc ảnh nhiều trang bằng vision có thể kéo dài; nginx (erp-UI/nginx.conf) cũng phải >= giá trị này
export const AI_SERVICE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export const AI_SERVICE_POLL_INTERVAL_MS = 2000;
