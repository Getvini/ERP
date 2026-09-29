import axios from "axios";
import { assertAiServiceUrl, AI_SERVICE_MAX_FETCH_BYTES as MAX_FETCH_BYTES, AI_SERVICE_REQUEST_TIMEOUT_MS as REQUEST_TIMEOUT_MS } from "../../../shared/config/aiService";

export async function fetchRemoteFile(fileUrl: string): Promise<Buffer> {
    let fileRes;
    try {
        fileRes = await axios.get(fileUrl, {
            responseType: "arraybuffer",
            maxContentLength: MAX_FETCH_BYTES,
            maxRedirects: 5,
            timeout: REQUEST_TIMEOUT_MS,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            },
        });
    } catch (e: any) {
        throw Object.assign(new Error("Không thể tải file từ link, vui lòng kiểm tra lại đường dẫn hoặc quyền chia sẻ"), { statusCode: 400 });
    }

    const contentType = String(fileRes.headers?.["content-type"] || "");
    if (contentType.includes("text/html")) {
        throw Object.assign(
            new Error("Không thể tải file từ link. Với Google Sheets, hãy bật chia sẻ 'Bất kỳ ai có đường liên kết' rồi thử lại"),
            { statusCode: 400 }
        );
    }

    return Buffer.from(fileRes.data);
}

export class SpellingCheckService {
    async listSheets(fileBuffer: Buffer, fileName: string) {
        const formData = new FormData();
        formData.append("file", new Blob([new Uint8Array(fileBuffer)]), fileName);
        const res = await axios.post(`${assertAiServiceUrl()}/check/sheets`, formData, {
            timeout: REQUEST_TIMEOUT_MS,
            maxBodyLength: MAX_FETCH_BYTES,
            maxContentLength: MAX_FETCH_BYTES,
        });
        return res.data;
    }

    async listSheetsFromUrl(fileUrl: string, fileName: string) {
        const buffer = await fetchRemoteFile(fileUrl);
        return this.listSheets(buffer, fileName);
    }

    async start(fileBuffer: Buffer, fileName: string, lang: string, sheetNames?: string, whitelist?: string, scenarioIds?: string, regions?: string) {
        const formData = new FormData();
        formData.append("file", new Blob([new Uint8Array(fileBuffer)]), fileName);
        formData.append("lang", lang || "both");
        if (sheetNames) formData.append("sheet_names", sheetNames);
        if (whitelist) formData.append("whitelist", whitelist);
        if (scenarioIds !== undefined) {
            formData.append("scenario_scope", "explicit");
            if (scenarioIds) formData.append("scenario_ids", scenarioIds);
        }
        if (regions) formData.append("regions", regions);

        const res = await axios.post(`${assertAiServiceUrl()}/check/start`, formData, {
            timeout: REQUEST_TIMEOUT_MS,
            maxBodyLength: MAX_FETCH_BYTES,
            maxContentLength: MAX_FETCH_BYTES,
        });
        return res.data;
    }

    async startFromUrl(fileUrl: string, fileName: string, lang: string, sheetNames?: string, whitelist?: string, scenarioIds?: string, regions?: string) {
        const buffer = await fetchRemoteFile(fileUrl);
        return this.start(buffer, fileName, lang, sheetNames, whitelist, scenarioIds, regions);
    }

    async getStatus(jobId: string) {
        try {
            const res = await axios.get(`${assertAiServiceUrl()}/check/${jobId}`, { timeout: 10000 });
            return res.data;
        } catch (e: any) {
            if (e.response?.status === 404) {
                throw Object.assign(new Error("Không tìm thấy tác vụ kiểm tra chính tả"), { statusCode: 404 });
            }
            throw e;
        }
    }

    async getPdfStream(jobId: string) {
        const res = await axios.get(`${assertAiServiceUrl()}/check/${jobId}/pdf`, {
            responseType: "stream",
            timeout: REQUEST_TIMEOUT_MS,
        });
        return res.data;
    }

    async delete(jobId: string) {
        try {
            const res = await axios.delete(`${assertAiServiceUrl()}/check/${jobId}`, { timeout: 10000 });
            return res.data;
        } catch (e: any) {
            if (e.response?.status === 404) return { deleted: jobId };
            throw e;
        }
    }
}
