import axios from "axios";
import { ProjectProductDescriptionService } from "../../project/services/ProjectProductDescription.Service";
import { ProjectProductDescriptionStatus } from "../../project/entities/ProjectProductDescriptionSubmission.entity";
import { SettingService } from "../../setting/services/Setting.Service";
import type { ScanRegion } from "../../task/helpers/ScanScope.helper";
import {
    assertAiServiceUrl,
    AI_SERVICE_MAX_FETCH_BYTES as MAX_FETCH_BYTES,
    AI_SERVICE_REQUEST_TIMEOUT_MS as REQUEST_TIMEOUT_MS,
    AI_SERVICE_POLL_INTERVAL_MS,
} from "../../../shared/config/aiService";

type Actor = { id: string; userId?: string; role: string; username?: string };

export type QcBatchStatus = "pending" | "running" | "done" | "error";

export type QcBatchInfo = {
    key: string;
    sheet: string;
    index: number;
    status: QcBatchStatus;
    blockIds: string[];
    scenarios: { id: string; label: string; rowRange: number[] }[];
    mismatches: Record<string, any>[];
    unverified: number;
    cached: boolean;
    error: string | null;
    durationMs: number | null;
};

function toBatchInfo(sheetName: string, raw: any): QcBatchInfo {
    return {
        key: `${sheetName}#${raw.index}`,
        sheet: sheetName,
        index: raw.index,
        status: raw.status,
        blockIds: raw.block_ids || [],
        scenarios: (raw.scenarios || []).map((s: any) => ({ id: s.id, label: s.label, rowRange: s.row_range })),
        mismatches: (raw.mismatches || []).map((m: any) => ({ ...m, sheet_name: sheetName })),
        unverified: raw.unverified || 0,
        cached: Boolean(raw.cached),
        error: raw.error || null,
        durationMs: raw.duration_ms ?? null
    };
}

function httpError(message: string, statusCode: number) {
    const error = new Error(message) as Error & { statusCode?: number };
    error.statusCode = statusCode;
    return error;
}

async function submitAndPollQcJob(formData: FormData, onProgress?: (job: any) => void) {
    const aiServiceUrl = assertAiServiceUrl();
    const submitRes = await axios.post(`${aiServiceUrl}/qc/run`, formData, {
        timeout: REQUEST_TIMEOUT_MS,
        maxBodyLength: MAX_FETCH_BYTES,
        maxContentLength: MAX_FETCH_BYTES,
    });
    const jobId = submitRes.data.job_id;
    const start = Date.now();
    let lastSignature = "";

    while (true) {
        const statusRes = await axios.get(`${aiServiceUrl}/qc/run/${jobId}`, { timeout: 10000 });
        const job = statusRes.data;
        if (onProgress) {
            const signature = JSON.stringify(job.batches || []);
            if (signature !== lastSignature) {
                lastSignature = signature;
                onProgress(job);
            }
        }
        if (job.status === "done") {
            return job;
        }
        if (job.status === "error") {
            throw httpError(job.error || "Chạy QC thất bại", 502);
        }
        if (Date.now() - start > REQUEST_TIMEOUT_MS) {
            throw httpError("Chạy QC quá thời gian chờ", 504);
        }
        await new Promise((resolve) => setTimeout(resolve, AI_SERVICE_POLL_INTERVAL_MS));
    }
}

function stripHtml(html: string) {
    return String(html || "")
        .replace(/<(li|p|br|div|\/p|\/li|\/div)[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\n{2,}/g, "\n")
        .trim();
}

function toAiProductInfo(productInfo: any[]) {
    return productInfo.map((item) => ({
        productName: item.productName,
        content: stripHtml(item.extractedText),
        note: item.note,
    }));
}

export class QcService {
    private productDescriptionService = new ProjectProductDescriptionService();
    private settingService = new SettingService();

    async getApprovedProductInfo(projectId: string, actor?: Actor) {
        const submissions = await this.productDescriptionService.getByProject(projectId, actor);
        const approved = submissions.find((submission) => submission.status === ProjectProductDescriptionStatus.APPROVED);

        if (!approved) {
            throw httpError("Dự án chưa có thông tin chuẩn sản phẩm được duyệt, không thể chạy QC", 400);
        }

        return approved.items.map((item) => ({
            productName: item.productName,
            extractedText: item.extractedText,
            note: item.note,
            fileUrl: item.fileUrl,
        }));
    }

    async run(params: {
        fileBuffer: Buffer;
        fileName?: string;
        sheetNames: string[];
        projectId: string;
        scenarioIds?: string[];
        regions?: ScanRegion[];
        actor?: Actor;
        onBatches?: (batches: QcBatchInfo[]) => void;
        reviewerNote?: string;
        refresh?: boolean;
    }) {
        const productInfo = await this.getApprovedProductInfo(params.projectId, params.actor);
        const aiProductInfo = toAiProductInfo(productInfo);

        const qcConfig = await this.settingService.getQcConfig();

        const sheetNames = params.sheetNames.filter(Boolean);
        if (sheetNames.length === 0) {
            throw httpError("Vui lòng chọn ít nhất 1 sheet để chạy QC", 400);
        }

        const fileBuffer = params.fileBuffer;
        const fileName = params.fileName;

        const batchesBySheet = new Map<string, QcBatchInfo[]>();
        const flattenBatches = () => sheetNames.flatMap((name) => batchesBySheet.get(name) || []);

        const sheetResults = await Promise.all(sheetNames.map(async (sheetName) => {
            const sheetScenarioIds = params.scenarioIds
                ? params.scenarioIds.filter((sid) => sid.startsWith(`${sheetName}::`))
                : null;
            const sheetRegions = (params.regions || []).filter((region) => region.sheet === sheetName && region.qc !== false);
            if (params.scenarioIds && sheetScenarioIds!.length === 0 && sheetRegions.length === 0) {
                return { sheetName, data: { content_blocks: [], mismatch_report: { mismatches: [] }, models: null } };
            }

            const formData = new FormData();
            formData.append("file", new Blob([new Uint8Array(fileBuffer)]), fileName || "result");
            formData.append("sheet_name", sheetName);
            formData.append("product_info", JSON.stringify(aiProductInfo));
            if (qcConfig.isCustomized) {
                formData.append("provider", qcConfig.provider);
                formData.append("verify_model", qcConfig.verifyModel);
            }
            formData.append("reasoning_effort", qcConfig.reasoningEffort);
            if (params.reviewerNote) formData.append("reviewer_note", params.reviewerNote);
            if (params.refresh) formData.append("refresh", "true");
            formData.append("max_scenarios_per_batch", String(qcConfig.maxBatch));
            formData.append("context_window", String(qcConfig.maxContext));
            if (sheetScenarioIds) {
                formData.append("scenario_scope", "explicit");
                if (sheetScenarioIds.length > 0) formData.append("scenario_ids", sheetScenarioIds.join(","));
            }
            if (sheetRegions.length > 0) formData.append("regions", JSON.stringify(sheetRegions));

            const data = await submitAndPollQcJob(formData, (job) => {
                batchesBySheet.set(sheetName, (job.batches || []).map((raw: any) => toBatchInfo(sheetName, raw)));
                params.onBatches?.(flattenBatches());
            });
            batchesBySheet.set(sheetName, (data?.batches || []).map((raw: any) => toBatchInfo(sheetName, raw)));
            return { sheetName, data };
        }));

        const mismatches = sheetResults.flatMap(({ sheetName, data }) =>
            (data?.mismatch_report?.mismatches || []).map((m: any) => ({ ...m, sheet_name: sheetName }))
        );

        const contentBlocks: Record<string, any> = {};
        for (const { sheetName, data } of sheetResults) {
            contentBlocks[sheetName] = data?.content_blocks;
        }

        const stats = sheetResults.reduce(
            (acc, { data }) => ({
                total_blocks: acc.total_blocks + (data?.stats?.total_blocks ?? 0),
                reused_blocks: acc.reused_blocks + (data?.stats?.reused_blocks ?? 0),
                checked_blocks: acc.checked_blocks + (data?.stats?.checked_blocks ?? 0),
            }),
            { total_blocks: 0, reused_blocks: 0, checked_blocks: 0 }
        );

        return {
            sheets: sheetNames,
            stats,
            content_blocks: contentBlocks,
            batches: flattenBatches(),
            mismatch_report: { mismatches },
            models: sheetResults[0]?.data?.models,
        };
    }
}