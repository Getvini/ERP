import * as XLSX from "xlsx";
import { fetchRemoteFile } from "../../modules/spelling-check/services/SpellingCheck.Service";

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 2;
const MAX_PREVIEW_BYTES = 80 * 1024 * 1024;
const MAX_ROW_COUNT = 200;
const MAX_COL_COUNT = 60;
const DEFAULT_ROW_COUNT = 60;
const DEFAULT_COL_COUNT = 20;
const MAX_CELL_TEXT = 500;

export type PreviewWindowRequest = {
    sheet?: string;
    rowStart?: number | string;
    rowCount?: number | string;
    colStart?: number | string;
    colCount?: number | string;
};

export type PreviewWindow = {
    sheets: string[];
    sheet: string;
    maxRow: number;
    maxCol: number;
    rowStart: number;
    colStart: number;
    rows: (string | null)[][];
    merges: { startRow: number; startCol: number; endRow: number; endCol: number }[];
};

type CacheEntry = { workbook: XLSX.WorkBook; at: number };

const cache = new Map<string, CacheEntry>();

function httpError(message: string, statusCode: number) {
    return Object.assign(new Error(message), { statusCode });
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

function pruneCache() {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (now - entry.at > CACHE_TTL_MS) cache.delete(key);
    }
    while (cache.size > CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value as string;
        cache.delete(oldest);
    }
}

function toWorkbook(buffer: Buffer): XLSX.WorkBook {
    if (buffer.length > MAX_PREVIEW_BYTES) throw httpError("File quá lớn để xem trước", 413);
    try {
        return XLSX.read(buffer, { type: "buffer", cellStyles: false, cellDates: false });
    } catch {
        throw httpError("Không đọc được file bảng tính để xem trước", 400);
    }
}

function cellText(cell: XLSX.CellObject | undefined): string | null {
    if (!cell) return null;
    const raw = cell.w ?? (cell.v !== undefined && cell.v !== null ? String(cell.v) : null);
    if (raw === null || raw === "") return null;
    return raw.length > MAX_CELL_TEXT ? raw.slice(0, MAX_CELL_TEXT) : raw;
}

function buildWindow(workbook: XLSX.WorkBook, request: PreviewWindowRequest): PreviewWindow {
    const sheets = workbook.SheetNames;
    if (sheets.length === 0) throw httpError("File không có sheet nào", 400);
    const sheetName = request.sheet && sheets.includes(request.sheet) ? request.sheet : sheets[0];
    if (request.sheet && !sheets.includes(request.sheet)) throw httpError(`Không tìm thấy sheet "${request.sheet}"`, 404);

    const worksheet = workbook.Sheets[sheetName];
    const ref = worksheet["!ref"];
    const range = ref ? XLSX.utils.decode_range(ref) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    const maxRow = ref ? range.e.r + 1 : 0;
    const maxCol = ref ? range.e.c + 1 : 0;

    const rowCount = clampInt(request.rowCount, DEFAULT_ROW_COUNT, 1, MAX_ROW_COUNT);
    const colCount = clampInt(request.colCount, DEFAULT_COL_COUNT, 1, MAX_COL_COUNT);
    const rowStart = clampInt(request.rowStart, 1, 1, 1048576);
    const colStart = clampInt(request.colStart, 1, 1, 16384);

    const rows: (string | null)[][] = [];
    for (let r = rowStart; r < rowStart + rowCount; r++) {
        const line: (string | null)[] = [];
        for (let c = colStart; c < colStart + colCount; c++) {
            line.push(cellText(worksheet[XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })]));
        }
        rows.push(line);
    }

    const rowEnd = rowStart + rowCount - 1;
    const colEnd = colStart + colCount - 1;
    const merges = (worksheet["!merges"] || [])
        .map(m => ({ startRow: m.s.r + 1, startCol: m.s.c + 1, endRow: m.e.r + 1, endCol: m.e.c + 1 }))
        .filter(m => m.endRow >= rowStart && m.startRow <= rowEnd && m.endCol >= colStart && m.startCol <= colEnd);

    return { sheets, sheet: sheetName, maxRow, maxCol, rowStart, colStart, rows, merges };
}

export class SheetPreviewService {
    static async fromCachedFile(key: string, load: () => Promise<Buffer>, request: PreviewWindowRequest): Promise<PreviewWindow> {
        pruneCache();
        let entry = cache.get(key);
        if (!entry) {
            entry = { workbook: toWorkbook(await load()), at: Date.now() };
            cache.set(key, entry);
            pruneCache();
        } else {
            entry.at = Date.now();
        }
        return buildWindow(entry.workbook, request);
    }

    static fromUrl(fileUrl: string, request: PreviewWindowRequest) {
        return this.fromCachedFile(`url:${fileUrl}`, () => fetchRemoteFile(fileUrl), request);
    }
}
