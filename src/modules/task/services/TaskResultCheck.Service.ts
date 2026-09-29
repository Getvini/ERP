import axios from "axios";
import path from "path";
import PDFDocument from "pdfkit";
import { AppDataSource } from "../../../data-source";
import { TaskResultChecks, TaskResultCheckStatus } from "../entities/TaskResultCheck.entity";
import { taskResultCheckEmitter, TASK_RESULT_CHECK_EVENTS } from "../events/TaskResultCheckEmitter";
import { SpellingCheckService } from "../../spelling-check/services/SpellingCheck.Service";
import { QcService } from "../../qc/services/Qc.Service";
import { ProjectSpellCheckWhitelistService } from "../../spelling-whitelist/services/ProjectSpellCheckWhitelist.Service";
import { filterWorkbookSheets } from "../../../shared/helpers/xlsxFilter.helper";
import { rawLocationToExcelRef } from "../../../shared/helpers/excelRef.helper";
import { buildCheckSummary } from "../../../shared/helpers/CheckSummary.helper";
import { buildHighlightedWorkbook } from "../../../shared/helpers/xlsxHighlight.helper";
import { drawTable } from "../../../shared/helpers/pdfTable.helper";
import { renderRichTextToPdf } from "../../../shared/helpers/richTextPdf.helper";
import { uploadBufferToCloudinary } from "../../../shared/helpers/cloudinary.helper";
import { isProjectManagementRole } from "../../account/entities/Account.entity";
import { TaskBaseService } from "./Task.BaseService";
import { Tasks } from "../entities/Task.entity";
import { Users } from "../../user/entities/User.entity";
import { MemberRole, memberHasRole } from "../../project/entities/TeamMember.entity";
import { SheetPreviewService, PreviewWindowRequest } from "../../../shared/services/SheetPreview.Service";
import {
    ScanRegion,
    ScanScope,
    normalizeRegions,
    normalizeScenarioIds,
    qcItemInScope,
    sheetsOfScope,
    spellItemInScope,
    stableItemId,
    upsertRegions
} from "../helpers/ScanScope.helper";

const MAX_FETCH_BYTES = 500 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const SHEET_EXTENSIONS = ["xlsx", "xlsm"];
const FONT_REGULAR = path.join(__dirname, "../../../../assets/fonts/DejaVuSans.ttf");
const FONT_BOLD = path.join(__dirname, "../../../../assets/fonts/DejaVuSans-Bold.ttf");

type Actor = { id?: string; userId?: string; role?: string };

type CheckParams = {
    taskId: string;
    projectId?: string;
    fileBuffer?: Buffer;
    fileUrl?: string;
    fileName: string;
    sheetNames: string[];
    whitelist: string[];
    scenarioIds?: string[];
    regions?: ScanRegion[];
    actor?: Actor;
};

type RerunKind = "SPELL" | "QC" | "BOTH";

type ScannedScenario = NonNullable<TaskResultChecks["scannedScenarios"]>[number];

function mergeScannedScenarios(current: ScannedScenario[] | null | undefined, incoming: ScannedScenario[], partial: boolean) {
    if (!partial) return incoming;
    const map = new Map<string, ScannedScenario>();
    for (const item of current || []) map.set(item.id, item);
    for (const item of incoming || []) map.set(item.id, item);
    return Array.from(map.values());
}

function bareCellRef(ref: string) {
    const idx = ref.lastIndexOf("!");
    return idx >= 0 ? ref.slice(idx + 1) : ref;
}

function getExt(name: string) {
    return (name.split(".").pop() || "").toLowerCase();
}

async function fetchRemoteFile(fileUrl: string): Promise<Buffer> {
    const res = await axios.get(fileUrl, {
        responseType: "arraybuffer",
        maxContentLength: MAX_FETCH_BYTES,
        maxRedirects: 5,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        },
    });
    console.log(`[RESULT_CHECK_DEBUG] fetchRemoteFile(scan) url=${fileUrl} content-type=${res.headers?.["content-type"]} bytes=${res.data?.length} at=${new Date().toISOString()}`);
    return Buffer.from(res.data);
}

export class TaskResultCheckService extends TaskBaseService {
    private repository = AppDataSource.getRepository(TaskResultChecks);
    private spellingCheckService = new SpellingCheckService();
    private qcService = new QcService();
    private whitelistService = new ProjectSpellCheckWhitelistService();

    private async mergeProjectWhitelist(projectId: string | undefined, whitelist: string[], actor?: Actor) {
        if (!projectId) return whitelist;
        const projectWords = await this.whitelistService.getWords(projectId, actor as any);
        const merged = new Set(whitelist);
        for (const entry of projectWords) merged.add(entry.word);
        return Array.from(merged);
    }

    private canReviewChecks(task: Tasks, actor?: Actor) {
        const actorUserId = this.getActorUserId(actor);
        return isProjectManagementRole(actor?.role)
            || this.isProjectOperatorFromTeam(task.project?.team, actor)
            || task.assignerId === actorUserId;
    }

    private canViewChecks(task: Tasks, actor?: Actor) {
        const actorUserId = this.getActorUserId(actor);
        return this.canReviewChecks(task, actor) || task.assigneeId === actorUserId;
    }

    private assertCanAccess(task: Tasks, actor?: Actor) {
        if (!this.canViewChecks(task, actor)) throw this.httpError("Bạn không có quyền xem thông tin kiểm tra của công việc này", 403);
    }

    private assertCanReview(task: Tasks, actor?: Actor) {
        if (!this.canReviewChecks(task, actor)) throw this.httpError("Bạn không có quyền chốt kiểm tra của công việc này", 403);
    }

    private reviewerRecipients(task: Tasks): Users[] {
        const map = new Map<string, Users>();
        if (task.project?.team?.teamLead) map.set(task.project.team.teamLead.id, task.project.team.teamLead);
        if (task.supervisor) map.set(task.supervisor.id, task.supervisor);
        if (task.assigner) map.set(task.assigner.id, task.assigner);
        for (const member of task.project?.team?.members || []) {
            if (memberHasRole(member, MemberRole.PROJECT_MANAGER) && member.user) map.set(member.user.id, member.user);
        }
        return Array.from(map.values());
    }

    async startForSubmission(params: CheckParams) {
        const ext = getExt(params.fileName || "");
        const regions = params.regions || [];
        if (params.sheetNames.length === 0) {
            params.sheetNames = sheetsOfScope({ scenarioIds: params.scenarioIds, regions });
        }
        if (!SHEET_EXTENSIONS.includes(ext) || params.sheetNames.length === 0) {
            console.log(`[RESULT_CHECK_DEBUG] startForSubmission BO QUA quet (khong tao record) taskId=${params.taskId} fileName=${params.fileName} ext=${ext} sheetNames=${JSON.stringify(params.sheetNames)} scenarioIds=${JSON.stringify(params.scenarioIds)}`);
            const deleted = await this.repository.delete({ taskId: params.taskId });
            if (deleted.affected) taskResultCheckEmitter.emit(TASK_RESULT_CHECK_EVENTS.UPDATED, { taskId: params.taskId });
            return;
        }
        console.log(`[RESULT_CHECK_DEBUG] startForSubmission BAT DAU quet taskId=${params.taskId} fileUrl=${params.fileUrl || "(buffer)"} fileName=${params.fileName} sheetNames=${JSON.stringify(params.sheetNames)} scenarioIds=${JSON.stringify(params.scenarioIds)}`);

        await this.repository.delete({ taskId: params.taskId });
        let record = this.repository.create({
            taskId: params.taskId,
            status: TaskResultCheckStatus.RUNNING,
            spellStatus: TaskResultCheckStatus.RUNNING,
            qcStatus: TaskResultCheckStatus.RUNNING,
            sheetNames: params.sheetNames,
            scenarioIds: params.scenarioIds ?? null,
            scanRegions: regions.length > 0 ? regions : null,
            qcSkippedReason: null
        });
        record = await this.repository.save(record);
        taskResultCheckEmitter.emit(TASK_RESULT_CHECK_EVENTS.UPDATED, { taskId: params.taskId });

        this.run(record.id, params).catch(async (err: any) => {
            const message = err?.message || "Lỗi không xác định khi kiểm tra kết quả";
            await this.repository.update(record.id, {
                status: TaskResultCheckStatus.ERROR,
                errorMessage: message,
                spellStatus: TaskResultCheckStatus.ERROR,
                spellErrorMessage: message,
                qcStatus: TaskResultCheckStatus.ERROR,
                qcErrorMessage: message
            });
            taskResultCheckEmitter.emit(TASK_RESULT_CHECK_EVENTS.UPDATED, { taskId: params.taskId });
        });
    }

    private async run(recordId: string, params: CheckParams) {
        let buffer = params.fileBuffer;
        if (!buffer && params.fileUrl) buffer = await fetchRemoteFile(params.fileUrl);
        if (!buffer) throw new Error("Không có dữ liệu file để kiểm tra");
        console.log(`[RESULT_CHECK_DEBUG] run() recordId=${recordId} raw buffer bytes=${buffer.length} sheetNames=${JSON.stringify(params.sheetNames)}`);

        const filteredBuffer = filterWorkbookSheets(buffer, params.sheetNames);
        console.log(`[RESULT_CHECK_DEBUG] run() recordId=${recordId} filtered buffer bytes=${filteredBuffer.length}`);
        const uploaded = await uploadBufferToCloudinary(filteredBuffer, params.fileName, `GETVINI/ERP/TASK/${params.taskId}/CHECKS`);

        await this.repository.update(recordId, {
            filteredFileUrl: uploaded.url,
            fileName: params.fileName
        });

        const mergedWhitelist = await this.mergeProjectWhitelist(params.projectId, params.whitelist, params.actor);

        const scope: ScanScope = { scenarioIds: params.scenarioIds, regions: params.regions || [] };
        const displayMultiSheet = params.sheetNames.length > 1;

        await Promise.all([
            this.runSpellCheck(recordId, params.taskId, filteredBuffer, params.fileName, params.sheetNames, mergedWhitelist, scope, displayMultiSheet, false),
            this.runQcCheck(recordId, params.taskId, filteredBuffer, params.fileName, params.sheetNames, scope, params.projectId, params.actor, false)
        ]);

        const finalRecord = await this.repository.findOne({ where: { id: recordId } });
        const overallStatus = finalRecord?.spellStatus === TaskResultCheckStatus.DONE && finalRecord?.qcStatus === TaskResultCheckStatus.DONE
            ? TaskResultCheckStatus.DONE
            : TaskResultCheckStatus.ERROR;
        await this.repository.update(recordId, { status: overallStatus });

        const task = await this.getOne(params.taskId);
        await this.notifyRawScanDone(task, finalRecord?.reviewedSpellErrors || [], finalRecord?.reviewedQcMismatches || []);
    }

    private async runSpellCheck(
        recordId: string,
        taskId: string,
        buffer: Buffer,
        fileName: string,
        sheetNames: string[],
        whitelist: string[],
        scope: ScanScope,
        displayMultiSheet: boolean,
        partial: boolean
    ) {
        try {
            const spell = await this.executeSpellCheck(buffer, fileName, sheetNames, whitelist, scope, displayMultiSheet);
            console.log(`[RESULT_CHECK_DEBUG] executeSpellCheck OK recordId=${recordId} requested_scenarioIds=${JSON.stringify(scope.scenarioIds)} regions=${scope.regions.length} spellErrors=${spell.spellErrors?.length ?? 0} scannedScenarios=${spell.scannedScenarios?.length ?? 0}`);
            await this.applySpellResult(recordId, spell, partial ? scope : null);
        } catch (err: any) {
            console.log(`[RESULT_CHECK_DEBUG] executeSpellCheck LOI recordId=${recordId} status=${err?.response?.status} detail=${JSON.stringify(err?.response?.data)} message=${err?.message}`);
            await this.repository.update(recordId, {
                spellStatus: TaskResultCheckStatus.ERROR,
                spellErrorMessage: err?.message || "Lỗi khi kiểm tra chính tả"
            });
        }
        taskResultCheckEmitter.emit(TASK_RESULT_CHECK_EVENTS.UPDATED, { taskId });
    }

    private async runQcCheck(
        recordId: string,
        taskId: string,
        buffer: Buffer,
        fileName: string,
        sheetNames: string[],
        scope: ScanScope,
        projectId: string | undefined,
        actor: Actor | undefined,
        partial: boolean
    ) {
        try {
            const qc = await this.executeQcCheck(buffer, fileName, sheetNames, scope, projectId, actor);
            console.log(`[RESULT_CHECK_DEBUG] executeQcCheck OK recordId=${recordId} projectId=${projectId} requested_scenarioIds=${JSON.stringify(scope.scenarioIds)} regions=${scope.regions.length} qcMismatches=${qc.qcMismatches?.length ?? 0} skipped=${qc.qcSkippedReason ?? "no"}`);
            await this.applyQcResult(recordId, qc, partial ? scope : null);
        } catch (err: any) {
            console.log(`[RESULT_CHECK_DEBUG] executeQcCheck LOI recordId=${recordId} status=${err?.response?.status} detail=${JSON.stringify(err?.response?.data)} message=${err?.message}`);
            await this.repository.update(recordId, {
                qcStatus: TaskResultCheckStatus.ERROR,
                qcErrorMessage: err?.message || "Lỗi khi kiểm tra QC"
            });
        }
        taskResultCheckEmitter.emit(TASK_RESULT_CHECK_EVENTS.UPDATED, { taskId });
    }

    private async notifyRawScanDone(task: Tasks, spellErrors: any[], qcMismatches: Record<string, any>[]) {
        const summary = buildCheckSummary(spellErrors, qcMismatches);
        if (!summary) return;

        for (const recipient of this.reviewerRecipients(task)) {
            await this.notificationService.createNotification({
                title: "Kết quả quét chính tả/QC (chưa chốt)",
                content: `Công việc "${task.nickname || task.name}" của dự án ${task.project?.name} vừa quét xong, vui lòng rà soát và chốt lỗi:\n${summary}`,
                type: "TASK_RESULT_CHECK_RAW",
                recipient,
                relatedEntityId: task.id.toString(),
                relatedEntityType: "Task",
                link: `/tasks/${task.id}`
            });
        }
    }

    private async notifyFinalized(task: Tasks, spellErrors: any[], qcMismatches: Record<string, any>[]) {
        const summary = buildCheckSummary(spellErrors, qcMismatches);
        if (!summary) return;

        const recipients = new Map<string, Users>();
        if (task.assignee) recipients.set(task.assignee.id, task.assignee);
        for (const reviewer of this.reviewerRecipients(task)) recipients.set(reviewer.id, reviewer);

        for (const recipient of recipients.values()) {
            await this.notificationService.createNotification({
                title: "Kết quả kiểm tra chính tả/QC đã chốt",
                content: `Công việc "${task.nickname || task.name}" của dự án ${task.project?.name} đã chốt kết quả kiểm tra:\n${summary}`,
                type: "TASK_RESULT_CHECK_DONE",
                recipient,
                relatedEntityId: task.id.toString(),
                relatedEntityType: "Task",
                link: `/tasks/${task.id}`
            });
        }
    }

    private async executeSpellCheck(
        buffer: Buffer,
        fileName: string,
        sheetNames: string[],
        whitelist: string[],
        scope: ScanScope,
        displayMultiSheet: boolean
    ) {
        const spellJob = await this.spellingCheckService.start(
            buffer,
            fileName,
            "both",
            sheetNames.join(","),
            whitelist.join(","),
            scope.scenarioIds ? scope.scenarioIds.join(",") : undefined,
            scope.regions.length > 0 ? JSON.stringify(scope.regions) : undefined
        );
        const { errors: spellErrors, scannedScenarios } = await this.pollSpellJob(spellJob.job_id);

        const seen = new Map<string, number>();
        const spellErrorsWithId = spellErrors.map((e: any) => {
            const cell = bareCellRef(rawLocationToExcelRef(e.location));
            return {
                id: stableItemId("spell", [e.sheet, cell, e.token], seen),
                location: displayMultiSheet && e.sheet ? `${e.sheet}!${cell}` : cell,
                token: e.token,
                sheetName: e.sheet || null,
                scenarioLabel: e.scenario || null,
                scenarioId: e.scenarioId || null
            };
        });
        const reviewedSpellErrors = spellErrorsWithId.map(e => ({ ...e, confirmed: true }));

        return { spellErrors: spellErrorsWithId, reviewedSpellErrors, scannedScenarios: scannedScenarios as ScannedScenario[] };
    }

    private async applySpellResult(
        recordId: string,
        spell: Awaited<ReturnType<TaskResultCheckService["executeSpellCheck"]>>,
        partialScope: ScanScope | null
    ) {
        await AppDataSource.transaction(async (manager) => {
            const repo = manager.getRepository(TaskResultChecks);
            const record = await repo.findOne({ where: { id: recordId }, lock: { mode: "pessimistic_write" } });
            if (!record) return;

            const fallbackSheet = record.sheetNames?.length === 1 ? record.sheetNames[0] : null;
            const previous = record.reviewedSpellErrors || [];
            const previousById = new Map(previous.map(item => [item.id, item]));
            const outOfScope = <T extends { location: string; sheetName?: string | null; scenarioId?: string | null }>(items: T[]) =>
                partialScope ? items.filter(item => !spellItemInScope(item, partialScope, fallbackSheet)) : [];

            record.spellErrors = [...outOfScope(record.spellErrors || []), ...spell.spellErrors];
            record.reviewedSpellErrors = [
                ...outOfScope(previous),
                ...spell.reviewedSpellErrors.map(item => ({ ...item, confirmed: previousById.get(item.id)?.confirmed ?? item.confirmed }))
            ];
            record.scannedScenarios = mergeScannedScenarios(record.scannedScenarios, spell.scannedScenarios, Boolean(partialScope));
            record.spellStatus = TaskResultCheckStatus.DONE;
            record.spellErrorMessage = null;
            await repo.save(record);
        });
    }

    private async executeQcCheck(
        buffer: Buffer,
        fileName: string,
        sheetNames: string[],
        scope: ScanScope,
        projectId?: string,
        actor?: Actor
    ) {
        let qcMismatches: Record<string, any>[] = [];
        let qcModels: { verify: string } | null = null;
        let qcSkippedReason: string | null = null;
        if (!projectId) {
            qcSkippedReason = "Công việc chưa thuộc dự án nào nên không có thông tin chuẩn để đối chiếu QC";
        } else {
            try {
                const qcResult = await this.qcService.run({
                    fileBuffer: buffer,
                    fileName,
                    sheetNames,
                    projectId,
                    scenarioIds: scope.scenarioIds,
                    regions: scope.regions,
                    actor: actor as any
                });
                qcMismatches = qcResult?.mismatch_report?.mismatches || [];
                qcModels = qcResult?.models || null;
            } catch (err: any) {
                if (err?.statusCode === 400) {
                    qcSkippedReason = err?.message || "Không thể chạy QC với dữ liệu hiện tại";
                } else {
                    throw new Error(err?.response?.data?.detail || err?.message || "Không thể chạy QC do lỗi máy chủ AI service");
                }
            }
        }

        const seen = new Map<string, number>();
        const reviewedQcMismatches = qcMismatches.map((m: any) => ({
            ...m,
            id: stableItemId("qc", [m.sheet_name, m.id, m.product_ref, m.attribute, m.claimed_value], seen),
            confirmed: m.status !== "unresolved"
        }));

        return { qcMismatches, reviewedQcMismatches, qcModels, qcSkippedReason };
    }

    private async applyQcResult(
        recordId: string,
        qc: Awaited<ReturnType<TaskResultCheckService["executeQcCheck"]>>,
        partialScope: ScanScope | null
    ) {
        await AppDataSource.transaction(async (manager) => {
            const repo = manager.getRepository(TaskResultChecks);
            const record = await repo.findOne({ where: { id: recordId }, lock: { mode: "pessimistic_write" } });
            if (!record) return;

            const previous = record.reviewedQcMismatches || [];
            const previousById = new Map(previous.map(item => [item.id, item]));
            const outOfScope = <T extends Record<string, any>>(items: T[]) =>
                partialScope ? items.filter(item => !qcItemInScope(item, partialScope)) : [];

            record.qcMismatches = [...outOfScope(record.qcMismatches || []), ...qc.qcMismatches];
            record.reviewedQcMismatches = [
                ...outOfScope(previous),
                ...qc.reviewedQcMismatches.map(item => ({ ...item, confirmed: previousById.get(item.id)?.confirmed ?? item.confirmed }))
            ];
            record.qcModels = qc.qcModels ?? record.qcModels;
            record.qcSkippedReason = qc.qcSkippedReason;
            record.qcStatus = TaskResultCheckStatus.DONE;
            record.qcErrorMessage = null;
            await repo.save(record);
        });
    }

    private async pollSpellJob(jobId: string): Promise<{ errors: any[]; scannedScenarios: any[] }> {
        const maxAttempts = 200;
        for (let i = 0; i < maxAttempts; i++) {
            const status = await this.spellingCheckService.getStatus(jobId);
            if (status.status === "done") return { errors: status.errors || [], scannedScenarios: status.scanned_scenarios || [] };
            if (status.status === "error") throw new Error(status.error || "Lỗi khi kiểm tra chính tả");
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
        throw new Error("Kiểm tra chính tả quá thời gian chờ");
    }

    async getForTask(taskId: string, actor?: Actor) {
        const task = await this.getOne(taskId);
        this.assertCanAccess(task, actor);
        const record = await this.repository.findOne({ where: { taskId } });
        if (!record) return record;

        const canReview = this.canReviewChecks(task, actor);
        if (canReview) {
            record.reviewerWhitelist = await this.mergeProjectWhitelist(
                task.project?.id,
                record.reviewerWhitelist || [],
                actor
            );
            return { ...record, canReview: true };
        }

        const base = {
            id: record.id,
            taskId: record.taskId,
            status: record.status,
            spellStatus: record.spellStatus,
            qcStatus: record.qcStatus,
            finalizedAt: record.finalizedAt,
            canReview: false
        };

        if (!record.finalizedAt) {
            return { ...base, reviewedSpellErrors: [], reviewedQcMismatches: [] };
        }

        return {
            ...base,
            qcModels: record.qcModels,
            qcSkippedReason: record.qcSkippedReason,
            sheetNames: record.sheetNames,
            scenarioIds: record.scenarioIds,
            scanRegions: record.scanRegions,
            scannedScenarios: record.scannedScenarios,
            reviewedSpellErrors: (record.reviewedSpellErrors || []).filter(i => i.confirmed),
            reviewedQcMismatches: (record.reviewedQcMismatches || []).filter(i => i.confirmed)
        };
    }

    async toggleItem(taskId: string, kind: "SPELL" | "QC", itemId: string, confirmed: boolean, actor?: Actor) {
        return this.toggleItems(taskId, kind, [itemId], confirmed, actor);
    }

    async toggleItems(taskId: string, kind: "SPELL" | "QC", itemIds: string[], confirmed: boolean, actor?: Actor) {
        const task = await this.getOne(taskId);
        this.assertCanReview(task, actor);

        // Các từ được tick lại và không còn mục nào cùng từ đó bị bỏ tick -> phải gỡ khỏi whitelist.
        let restoredTokens: string[] = [];

        const saved = await AppDataSource.transaction(async (manager) => {
            const repo = manager.getRepository(TaskResultChecks);
            const record = await repo.findOne({ where: { taskId }, lock: { mode: "pessimistic_write" } });
            if (!record) throw this.httpError("Không tìm thấy kết quả kiểm tra", 404);
            if (record.finalizedAt) throw this.httpError("Đã chốt kiểm tra, không thể chỉnh sửa", 409);

            const idSet = new Set(itemIds);
            if (kind === "SPELL") {
                record.reviewedSpellErrors = (record.reviewedSpellErrors || []).map(item =>
                    idSet.has(item.id) ? { ...item, confirmed } : item
                );

                if (confirmed) {
                    const touchedTokens = new Set(
                        record.reviewedSpellErrors
                            .filter(item => idSet.has(item.id))
                            .map(item => item.token)
                            .filter(Boolean)
                    );
                    const stillDismissed = new Set(
                        record.reviewedSpellErrors
                            .filter(item => !item.confirmed && touchedTokens.has(item.token))
                            .map(item => item.token)
                    );
                    restoredTokens = Array.from(touchedTokens).filter(token => !stillDismissed.has(token));

                    // reviewerWhitelist được lưu lại mỗi lần "Kiểm tra lại" nên cũng phải gỡ ở đây,
                    // nếu không từ đó sẽ tự quay lại whitelist khi getForTask gộp danh sách.
                    if (restoredTokens.length > 0 && record.reviewerWhitelist?.length) {
                        const restoredSet = new Set(restoredTokens);
                        record.reviewerWhitelist = record.reviewerWhitelist.filter(word => !restoredSet.has(word));
                    }
                }
            } else {
                record.reviewedQcMismatches = (record.reviewedQcMismatches || []).map(item =>
                    idSet.has(item.id) ? { ...item, confirmed } : item
                );
            }

            return await repo.save(record);
        });

        if (kind === "SPELL" && !confirmed && task.project?.id) {
            const dismissedTokens = (saved.reviewedSpellErrors || [])
                .filter(item => itemIds.includes(item.id))
                .map(item => item.token)
                .filter(Boolean);
            if (dismissedTokens.length > 0) {
                await this.whitelistService.addWords(task.project.id, dismissedTokens, actor as any);
            }
        }

        if (kind === "SPELL" && confirmed && restoredTokens.length > 0 && task.project?.id) {
            await this.whitelistService.removeWordsByText(task.project.id, restoredTokens, actor as any);
        }

        taskResultCheckEmitter.emit(TASK_RESULT_CHECK_EVENTS.UPDATED, { taskId });

        return saved;
    }

    async rerunCheck(
        taskId: string,
        kind: RerunKind,
        whitelist: string[],
        actor?: Actor,
        rawScope?: { scenarioIds?: unknown; regions?: unknown } | null
    ) {
        const task = await this.getOne(taskId);
        this.assertCanReview(task, actor);

        const record = await this.repository.findOne({ where: { taskId } });
        if (!record) throw this.httpError("Không tìm thấy kết quả kiểm tra", 404);
        if (record.finalizedAt) throw this.httpError("Đã chốt kiểm tra, không thể kiểm tra lại", 409);

        const kinds: ("SPELL" | "QC")[] = kind === "BOTH" ? ["SPELL", "QC"] : [kind];
        for (const k of kinds) {
            const currentStatus = k === "SPELL" ? record.spellStatus : record.qcStatus;
            if (currentStatus === TaskResultCheckStatus.RUNNING) throw this.httpError("Đang kiểm tra, vui lòng chờ", 409);
        }
        if (!record.filteredFileUrl) throw this.httpError("Không có file để kiểm tra lại", 400);

        const recordSheets = record.sheetNames || [];
        let partialScope: ScanScope | null = null;
        if (rawScope) {
            try {
                const regions = normalizeRegions(rawScope.regions, recordSheets);
                const scenarioIds = normalizeScenarioIds(rawScope.scenarioIds ?? [], recordSheets) || [];
                if (regions.length === 0 && scenarioIds.length === 0) {
                    throw this.httpError("Vui lòng chọn ít nhất một vùng hoặc kịch bản để quét lại", 400);
                }
                partialScope = { scenarioIds, regions };
            } catch (err: any) {
                throw this.httpError(err?.message || "Phạm vi quét lại không hợp lệ", err?.statusCode || 400);
            }
        }

        const update: Record<string, any> = {};
        if (kinds.includes("SPELL")) {
            update.spellStatus = TaskResultCheckStatus.RUNNING;
            update.spellErrorMessage = null;
            update.reviewerWhitelist = whitelist;
        }
        if (kinds.includes("QC")) {
            update.qcStatus = TaskResultCheckStatus.RUNNING;
            update.qcErrorMessage = null;
        }
        if (partialScope) {
            if (partialScope.regions.length > 0) update.scanRegions = upsertRegions(record.scanRegions, partialScope.regions);
            if (record.scenarioIds && partialScope.scenarioIds && partialScope.scenarioIds.length > 0) {
                update.scenarioIds = Array.from(new Set([...record.scenarioIds, ...partialScope.scenarioIds]));
            }
        }
        await this.repository.update(record.id, update);
        taskResultCheckEmitter.emit(TASK_RESULT_CHECK_EVENTS.UPDATED, { taskId });

        const refreshed = { ...record, ...update } as TaskResultChecks;
        void this.runRerun(record.id, task, refreshed, kinds, whitelist, partialScope, actor);

        return { status: TaskResultCheckStatus.RUNNING };
    }

    private async runRerun(
        recordId: string,
        task: Tasks,
        record: TaskResultChecks,
        kinds: ("SPELL" | "QC")[],
        whitelist: string[],
        partialScope: ScanScope | null,
        actor?: Actor
    ) {
        let buffer: Buffer;
        try {
            buffer = await fetchRemoteFile(record.filteredFileUrl as string);
        } catch (err: any) {
            const failure: Record<string, any> = {};
            const message = err?.message || "Không tải được file để kiểm tra lại";
            if (kinds.includes("SPELL")) Object.assign(failure, { spellStatus: TaskResultCheckStatus.ERROR, spellErrorMessage: message });
            if (kinds.includes("QC")) Object.assign(failure, { qcStatus: TaskResultCheckStatus.ERROR, qcErrorMessage: message });
            await this.repository.update(recordId, failure);
            taskResultCheckEmitter.emit(TASK_RESULT_CHECK_EVENTS.UPDATED, { taskId: task.id });
            return;
        }

        const fileName = record.fileName || (task.result as any)?.name || `${task.id}.xlsx`;
        const recordSheets = record.sheetNames || [];
        const scope: ScanScope = partialScope || {
            scenarioIds: record.scenarioIds ?? undefined,
            regions: record.scanRegions || []
        };
        const sheetNames = partialScope
            ? sheetsOfScope(partialScope).filter(sheet => recordSheets.includes(sheet))
            : recordSheets;
        const displayMultiSheet = recordSheets.length > 1;

        const jobs: Promise<void>[] = [];
        if (kinds.includes("SPELL")) {
            const mergedWhitelist = await this.mergeProjectWhitelist(task.project?.id, whitelist, actor);
            jobs.push(this.runSpellCheck(recordId, task.id, buffer, fileName, sheetNames, mergedWhitelist, scope, displayMultiSheet, Boolean(partialScope)));
        }
        if (kinds.includes("QC")) {
            jobs.push(this.runQcCheck(recordId, task.id, buffer, fileName, sheetNames, scope, task.project?.id, actor, Boolean(partialScope)));
        }
        await Promise.all(jobs);
    }

    async getPreview(taskId: string, request: PreviewWindowRequest, actor?: Actor) {
        const task = await this.getOne(taskId);
        this.assertCanAccess(task, actor);

        const record = await this.repository.findOne({ where: { taskId } });
        if (!record) throw this.httpError("Không tìm thấy kết quả kiểm tra", 404);
        if (!this.canReviewChecks(task, actor) && !record.finalizedAt) {
            throw this.httpError("Kết quả kiểm tra chưa được chốt nên chưa thể xem bảng", 403);
        }
        const fileUrl = record.filteredFileUrl;
        if (!fileUrl) throw this.httpError("File kiểm tra chưa sẵn sàng để xem", 409);

        return SheetPreviewService.fromCachedFile(`check:${fileUrl}`, () => fetchRemoteFile(fileUrl), request);
    }

    async finalize(taskId: string, actor?: Actor) {
        const task = await this.getOne(taskId);
        this.assertCanReview(task, actor);

        const record = await this.repository.findOne({ where: { taskId } });
        if (!record) throw this.httpError("Không tìm thấy kết quả kiểm tra", 404);
        if (record.spellStatus !== TaskResultCheckStatus.DONE || record.qcStatus !== TaskResultCheckStatus.DONE) {
            throw this.httpError("Chính tả và QC phải kiểm tra xong không lỗi trước khi chốt", 409);
        }

        record.finalizedAt = new Date();
        const saved = await this.repository.save(record);

        taskResultCheckEmitter.emit(TASK_RESULT_CHECK_EVENTS.UPDATED, { taskId });
        await this.notifyFinalized(task, record.reviewedSpellErrors || [], record.reviewedQcMismatches || []);

        return saved;
    }

    async buildPdf(taskId: string, actor?: Actor): Promise<Buffer> {
        const task = await this.getOne(taskId);
        this.assertCanAccess(task, actor);

        const record = await this.repository.findOne({ where: { taskId } });
        if (!record) throw this.httpError("Không tìm thấy kết quả kiểm tra", 404);

        const spellItems = (record.reviewedSpellErrors || []).filter(i => i.confirmed);
        const qcItems = (record.reviewedQcMismatches || []).filter(i => i.confirmed);

        const spellGroups = groupSpellErrors(spellItems);
        const qcGroups = groupQcMismatches(qcItems);

        let productInfoItems: { productName: string; extractedText: string | null; note: string | null }[] = [];
        if (task.project?.id) {
            try {
                productInfoItems = await this.qcService.getApprovedProductInfo(task.project.id, actor as any);
            } catch {
                productInfoItems = [];
            }
        }

        return await new Promise((resolve, reject) => {
            const doc = new PDFDocument({ margin: 40, bufferPages: true, size: "A4" });
            doc.registerFont("Base", FONT_REGULAR);
            doc.registerFont("Base-Bold", FONT_BOLD);
            doc.font("Base");

            const chunks: Buffer[] = [];
            doc.on("data", (c: Buffer) => chunks.push(c));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const x = doc.page.margins.left;

            doc.font("Base-Bold").fontSize(18).fillColor("#1e293b").text("Báo cáo kiểm tra kết quả công việc", { align: "center" });
            doc.font("Base").fontSize(9).fillColor("#94a3b8").text(`Xuất lúc ${new Date().toLocaleString("vi-VN")}`, { align: "center" });
            doc.moveDown(1.2);

            doc.rect(x, doc.y, 6, 16).fill("#16a34a");
            doc.font("Base-Bold").fontSize(13).fillColor("#1e293b").text(`  Thông tin chuẩn sản phẩm (${productInfoItems.length} sản phẩm)`, x + 10, doc.y - 14);
            doc.moveDown(0.8);

            if (productInfoItems.length === 0) {
                doc.font("Base").fontSize(10).fillColor("#64748b").text("Không có thông tin chuẩn sản phẩm");
                doc.moveDown();
            } else {
                for (const item of productInfoItems) {
                    doc.font("Base-Bold").fontSize(10.5).fillColor("#1e293b").text(item.productName || "(Không có tên sản phẩm)", x, doc.y, { width: contentWidth });
                    doc.moveDown(0.3);
                    renderRichTextToPdf(doc, item.extractedText || "", x, contentWidth, 9.5);
                    if (item.note) {
                        doc.moveDown(0.2);
                        doc.font("Base").fontSize(9).fillColor("#94a3b8").text(`Ghi chú: ${item.note}`, x, doc.y, { width: contentWidth });
                    }
                    doc.moveDown(0.8);
                }
            }

            doc.rect(x, doc.y, 6, 16).fill("#2563eb");
            doc.font("Base-Bold").fontSize(13).fillColor("#1e293b").text(`  Lỗi chính tả đã xác nhận (${spellItems.length} lỗi, ${spellGroups.length} loại)`, x + 10, doc.y - 14);
            doc.moveDown(0.8);

            if (spellGroups.length === 0) {
                doc.font("Base").fontSize(10).fillColor("#64748b").text("Không có lỗi được xác nhận");
                doc.moveDown();
            } else {
                const spellColumns = [
                    { header: "Sheet / Kịch bản", width: contentWidth * 0.28 },
                    { header: "Từ lỗi", width: contentWidth * 0.20 },
                    { header: "Số lần", width: contentWidth * 0.10 },
                    { header: "Vị trí", width: contentWidth * 0.42 }
                ];
                const spellRows = spellGroups.map(g => [
                    g.sheetName ? `${g.sheetName}${g.scenarioLabel ? ` / ${g.scenarioLabel}` : ""}` : "-",
                    g.token,
                    String(g.count),
                    g.locations.join(", ")
                ]);
                const endY = drawTable(doc, { x, y: doc.y, columns: spellColumns, rows: spellRows, headerColor: "#2563eb" });
                doc.y = endY + 18;
            }

            doc.rect(x, doc.y, 6, 16).fill("#ea580c");
            doc.font("Base-Bold").fontSize(13).fillColor("#1e293b").text(`  Điểm QC chưa khớp đã xác nhận (${qcItems.length} lỗi, ${qcGroups.length} thuộc tính)`, x + 10, doc.y - 14);
            doc.moveDown(0.8);

            if (record.qcSkippedReason) {
                doc.font("Base").fontSize(10).fillColor("#b45309").text(`QC chưa được quét: ${record.qcSkippedReason}`);
                doc.moveDown(0.5);
            }

            if (qcGroups.length === 0) {
                doc.font("Base").fontSize(10).fillColor("#64748b").text("Không có điểm chưa khớp được xác nhận");
            } else {
                const qcColumns = [
                    { header: "Thuộc tính", width: contentWidth * 0.18 },
                    { header: "Sản phẩm", width: contentWidth * 0.27 },
                    { header: "Ghi -> Chuẩn", width: contentWidth * 0.25 },
                    { header: "Ghi chú", width: contentWidth * 0.3 }
                ];
                const qcRows = qcGroups.flatMap(group =>
                    group.items.map(item => [
                        group.attribute,
                        `${item.sheetPrefix}${item.productRef}`,
                        `${item.claimedValue} -> ${item.expectedValue}`,
                        item.reasoning || ""
                    ])
                );
                doc.y = drawTable(doc, { x, y: doc.y, columns: qcColumns, rows: qcRows, headerColor: "#ea580c" });
            }

            const range = doc.bufferedPageRange();
            for (let i = range.start; i < range.start + range.count; i++) {
                doc.switchToPage(i);
                doc.font("Base").fontSize(8).fillColor("#94a3b8").text(
                    `Trang ${i + 1 - range.start}/${range.count}`,
                    0,
                    doc.page.height - 30,
                    { align: "center" }
                );
            }

            doc.end();
        });
    }

    async buildXlsx(taskId: string, actor?: Actor): Promise<Buffer> {
        const task = await this.getOne(taskId);
        this.assertCanAccess(task, actor);

        const record = await this.repository.findOne({ where: { taskId } });
        if (!record) throw this.httpError("Không tìm thấy kết quả kiểm tra", 404);
        if (!record.filteredFileUrl) throw this.httpError("Không có file để xuất", 400);

        const buffer = await fetchRemoteFile(record.filteredFileUrl);
        const spellItems = (record.reviewedSpellErrors || []).filter(i => i.confirmed);
        const qcItems = (record.reviewedQcMismatches || []).filter(i => i.confirmed);

        return await buildHighlightedWorkbook(buffer, record.sheetNames || [], spellItems, qcItems);
    }
}

function groupSpellErrors(items: { token: string; location: string; sheetName?: string | null; scenarioLabel?: string | null; scenarioId?: string | null }[]) {
    const map = new Map<string, { token: string; sheetName: string | null; scenarioLabel: string | null; locations: string[] }>();
    for (const item of items) {
        const sheetName = item.sheetName || null;
        const scenarioLabel = item.scenarioLabel || null;
        const key = `${sheetName || ""}|${item.scenarioId || scenarioLabel || ""}|${item.token}`;
        if (!map.has(key)) map.set(key, { token: item.token, sheetName, scenarioLabel, locations: [] });
        map.get(key)!.locations.push(item.location);
    }
    return Array.from(map.values()).map(g => ({
        token: g.token,
        sheetName: g.sheetName,
        scenarioLabel: g.scenarioLabel,
        count: g.locations.length,
        locations: g.locations
    }));
}

function groupQcMismatches(items: Record<string, any>[]) {
    const map = new Map<string, { sheetPrefix: string; productRef: string; claimedValue: string; expectedValue: string; reasoning: string }[]>();
    for (const item of items) {
        const key = item.attribute || "Không xác định";
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({
            sheetPrefix: item.sheet_name ? `${item.sheet_name}${item.scenario ? ` / ${item.scenario}` : ""} · ` : "",
            productRef: item.product_ref || "Không rõ sản phẩm",
            claimedValue: item.claimed_value,
            expectedValue: item.expected_value ?? "không tìm thấy",
            reasoning: item.reasoning || ""
        });
    }
    return Array.from(map.entries()).map(([attribute, entries]) => ({
        attribute,
        count: entries.length,
        items: entries
    }));
}
