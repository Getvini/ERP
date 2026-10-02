import { createHash } from "crypto";
import { excelRefToRowCol } from "../../../shared/helpers/excelRef.helper";

export type ScanRegion = {
    id: string;
    sheet: string;
    label?: string;
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
    qc?: boolean;
    extends?: string;
};

export type ScanScope = {
    scenarioIds?: string[];
    regions: ScanRegion[];
};

export const MAX_SCAN_REGIONS = 50;
const MAX_ROW = 1048576;
const MAX_COL = 16384;
const MAX_LABEL_LENGTH = 100;
const REGION_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export class ScanScopeError extends Error {
    statusCode = 400;
}

const toInt = (value: unknown): number | null => {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return typeof n === "number" && Number.isInteger(n) ? n : null;
};

export function normalizeRegions(raw: unknown, allowedSheets: string[]): ScanRegion[] {
    if (raw === undefined || raw === null || raw === "") return [];
    let data: unknown = raw;
    if (typeof raw === "string") {
        try {
            data = JSON.parse(raw);
        } catch {
            throw new ScanScopeError("Danh sách vùng quét không hợp lệ");
        }
    }
    if (!Array.isArray(data)) throw new ScanScopeError("Danh sách vùng quét không hợp lệ");
    if (data.length > MAX_SCAN_REGIONS) throw new ScanScopeError(`Chỉ được chọn tối đa ${MAX_SCAN_REGIONS} vùng quét`);

    const allowed = new Set(allowedSheets);
    const seen = new Set<string>();
    return data.map((item: any) => {
        const id = String(item?.id ?? "").trim();
        const sheet = String(item?.sheet ?? "").trim();
        if (!REGION_ID_PATTERN.test(id)) throw new ScanScopeError("Mã vùng quét không hợp lệ");
        if (!allowed.has(sheet)) throw new ScanScopeError(`Sheet "${sheet}" của vùng quét không nằm trong phạm vi đã chọn`);
        const key = `${sheet}|${id}`;
        if (seen.has(key)) throw new ScanScopeError("Mã vùng quét bị trùng");
        seen.add(key);

        const startRow = toInt(item?.startRow);
        const endRow = toInt(item?.endRow);
        const startCol = toInt(item?.startCol);
        const endCol = toInt(item?.endCol);
        if (startRow === null || endRow === null || startCol === null || endCol === null) {
            throw new ScanScopeError("Toạ độ vùng quét không hợp lệ");
        }
        if (startRow < 1 || endRow > MAX_ROW || startRow > endRow || startCol < 1 || endCol > MAX_COL || startCol > endCol) {
            throw new ScanScopeError("Toạ độ vùng quét nằm ngoài giới hạn của bảng tính");
        }
        const label = String(item?.label ?? "").trim().slice(0, MAX_LABEL_LENGTH);
        const extendsId = typeof item?.extends === "string" ? item.extends.trim().slice(0, 200) : "";
        const normalized: ScanRegion = { id, sheet, label, startRow, endRow, startCol, endCol, qc: item?.qc !== false };
        if (extendsId && extendsId.startsWith(`${sheet}::`)) normalized.extends = extendsId;
        return normalized;
    });
}

export function normalizeScenarioIds(raw: unknown, allowedSheets: string[]): string[] | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) throw new ScanScopeError("Danh sách kịch bản không hợp lệ");
    const ids = Array.from(new Set(raw.map(id => String(id).trim()).filter(Boolean)));
    for (const id of ids) {
        if (!allowedSheets.some(sheet => id.startsWith(`${sheet}::`))) {
            throw new ScanScopeError("Kịch bản không thuộc sheet nào trong phạm vi đã chọn");
        }
    }
    return ids;
}

export function parseIdList(raw: unknown): string[] | undefined {
    if (raw === undefined || raw === null) return undefined;
    return String(raw).split(",").map(s => s.trim()).filter(Boolean);
}

export function regionBlockId(region: Pick<ScanRegion, "id" | "sheet">) {
    return `${region.sheet}::CUSTOM:${region.id}`;
}

export function sheetsOfScope(scope: ScanScope): string[] {
    const sheets = new Set<string>();
    for (const region of scope.regions) sheets.add(region.sheet);
    for (const id of scope.scenarioIds || []) {
        const idx = id.indexOf("::");
        if (idx > 0) sheets.add(id.slice(0, idx));
    }
    return Array.from(sheets);
}

export function stableItemId(prefix: string, parts: (string | number | null | undefined)[], seen: Map<string, number>) {
    const base = parts.map(p => (p === null || p === undefined ? "" : String(p))).join("\u0001");
    const occurrence = seen.get(base) || 0;
    seen.set(base, occurrence + 1);
    const digest = createHash("sha1").update(`${base}\u0001${occurrence}`).digest("hex").slice(0, 12);
    return `${prefix}-${digest}`;
}

export function upsertRegions(current: ScanRegion[] | null | undefined, incoming: ScanRegion[]): ScanRegion[] {
    const map = new Map<string, ScanRegion>();
    for (const region of current || []) map.set(regionBlockId(region), region);
    for (const region of incoming) map.set(regionBlockId(region), region);
    return Array.from(map.values());
}

type SpellItem = { location: string; sheetName?: string | null; scenarioId?: string | null };
type QcItem = Record<string, any>;

function cellOf(item: SpellItem, fallbackSheet: string | null) {
    const parsed = excelRefToRowCol(item.location);
    if (!parsed) return null;
    return { sheet: item.sheetName || parsed.sheet || fallbackSheet, row: parsed.row, col: parsed.col };
}

function extendedScenarioIds(scope: ScanScope) {
    return new Set(scope.regions.map(region => region.extends).filter((id): id is string => Boolean(id)));
}

export function spellItemInScope(item: SpellItem, scope: ScanScope, fallbackSheet: string | null): boolean {
    if (item.scenarioId && (scope.scenarioIds || []).includes(item.scenarioId)) return true;
    if (item.scenarioId && extendedScenarioIds(scope).has(item.scenarioId)) return true;
    const cell = cellOf(item, fallbackSheet);
    if (!cell) return false;
    return scope.regions.some(region =>
        region.sheet === cell.sheet &&
        cell.row >= region.startRow && cell.row <= region.endRow &&
        cell.col >= region.startCol && cell.col <= region.endCol
    );
}

export function qcItemInScope(item: QcItem, scope: ScanScope): boolean {
    const blockId = item.blockId ?? item.id;
    if (blockId && (scope.scenarioIds || []).includes(blockId)) return true;
    if (blockId && extendedScenarioIds(scope).has(blockId)) return true;
    const range: number[] = Array.isArray(item.row_range) ? item.row_range : [item.row_range, item.row_range];
    const start = Number(range[0]);
    const end = Number(range[1] ?? range[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return scope.regions.some(region =>
        region.sheet === item.sheet_name &&
        region.qc !== false &&
        start <= region.endRow && end >= region.startRow
    );
}
