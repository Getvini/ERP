import { colNumberToLetters, excelRefToRowCol, rawLocationToExcelRef } from "./excelRef.helper";

export type ReportScopeItem = {
    kind: "scenario" | "region";
    sheet: string;
    label: string;
    range: string;
    qc: boolean;
};

export type ReportSpellGroup = {
    token: string;
    sheetName: string | null;
    scenarioLabel: string | null;
    count: number;
    locations: string[];
    firstRef: string | null;
};

export type ReportQcItem = {
    sheet: string | null;
    scenario: string | null;
    productRef: string;
    claimed: string;
    expected: string;
    reasoning: string;
    rowStart: number | null;
    rowEnd: number | null;
};

export type ReportQcGroup = { attribute: string; items: ReportQcItem[] };

export type ReportProduct = { productName: string; extractedText: string | null; note: string | null };

export interface CheckReportData {
    taskName: string;
    projectName: string | null;
    fileName: string | null;
    finalizedAt: Date | null;
    exportedAt: Date;
    sheetNames: string[];
    scope: ReportScopeItem[];
    totalScenarios: number;
    scannedScenarioCount: number;
    regionCount: number;
    spellTotal: number;
    spellGroups: ReportSpellGroup[];
    qcTotal: number;
    qcGroups: ReportQcGroup[];
    qcSkippedReason: string | null;
    products: ReportProduct[];
}

type ScannedScenario = {
    id: string;
    sheet: string;
    scenarioLabel: string;
    startRow: number | null;
    endRow: number | null;
    colStart?: number | null;
    colWidth?: number | null;
};

type RegionLike = { sheet: string; label?: string; startRow: number; endRow: number; startCol: number; endCol: number; qc?: boolean };

export const cellRangeLabel = (startRow: number, endRow: number, startCol: number, endCol: number) => {
    const a = `${colNumberToLetters(startCol)}${startRow}`;
    const b = `${colNumberToLetters(endCol)}${endRow}`;
    return a === b ? a : `${a}:${b}`;
};

export const scenarioRangeLabel = (s: ScannedScenario) => {
    if (s.startRow == null || s.endRow == null) return "-";
    if (s.colWidth && s.colWidth > 0) {
        const colStart = (s.colStart ?? 0) + 1;
        return cellRangeLabel(s.startRow, s.endRow, colStart, colStart + s.colWidth - 1);
    }
    return s.startRow === s.endRow ? `Dòng ${s.startRow}` : `Dòng ${s.startRow}–${s.endRow}`;
};

/** "Sheet!R8C1" | "Sheet!A8" | "A8" -> "A8" (bỏ tiền tố sheet để hiển thị gọn). */
export const plainCellRef = (location: string) => {
    const converted = rawLocationToExcelRef(location || "");
    const parsed = excelRefToRowCol(converted);
    return parsed ? `${colNumberToLetters(parsed.col)}${parsed.row}` : converted;
};

export function groupSpellErrors(
    items: { token: string; location: string; sheetName?: string | null; scenarioLabel?: string | null; scenarioId?: string | null }[]
): ReportSpellGroup[] {
    const map = new Map<string, ReportSpellGroup>();
    for (const item of items) {
        const sheetName = item.sheetName || excelRefToRowCol(rawLocationToExcelRef(item.location))?.sheet || null;
        const scenarioLabel = item.scenarioLabel || null;
        const key = `${sheetName || ""}|${item.scenarioId || scenarioLabel || ""}|${item.token}`;
        if (!map.has(key)) map.set(key, { token: item.token, sheetName, scenarioLabel, count: 0, locations: [], firstRef: null });
        const group = map.get(key)!;
        const ref = plainCellRef(item.location);
        if (!group.locations.includes(ref)) group.locations.push(ref);
        group.count += 1;
        if (!group.firstRef) group.firstRef = ref;
    }
    return Array.from(map.values()).sort(
        (a, b) =>
            (a.sheetName || "").localeCompare(b.sheetName || "") ||
            (a.scenarioLabel || "").localeCompare(b.scenarioLabel || "") ||
            b.count - a.count
    );
}

export function groupQcMismatches(items: Record<string, any>[]): ReportQcGroup[] {
    const map = new Map<string, ReportQcItem[]>();
    for (const item of items) {
        const key = item.attribute || "Không xác định";
        if (!map.has(key)) map.set(key, []);
        const range: number[] = Array.isArray(item.row_range) ? item.row_range : [item.row_range, item.row_range];
        const start = Number(range[0]);
        const end = Number(range[1] ?? range[0]);
        map.get(key)!.push({
            sheet: item.sheet_name || null,
            scenario: item.scenario || null,
            productRef: item.product_ref || "Không rõ sản phẩm",
            claimed: String(item.claimed_value ?? ""),
            expected: String(item.expected_value ?? "không tìm thấy"),
            reasoning: item.reasoning || "",
            rowStart: Number.isFinite(start) ? start : null,
            rowEnd: Number.isFinite(end) ? end : null
        });
    }
    return Array.from(map.entries()).map(([attribute, entries]) => ({ attribute, items: entries }));
}

export function buildCheckReportData(input: {
    taskName: string;
    projectName?: string | null;
    record: {
        fileName?: string | null;
        finalizedAt?: Date | null;
        sheetNames?: string[] | null;
        scenarioIds?: string[] | null;
        scanRegions?: RegionLike[] | null;
        scannedScenarios?: ScannedScenario[] | null;
        reviewedSpellErrors?: any[] | null;
        reviewedQcMismatches?: any[] | null;
        qcSkippedReason?: string | null;
    };
    products: ReportProduct[];
}): CheckReportData {
    const { record } = input;
    const spellItems = (record.reviewedSpellErrors || []).filter((i) => i.confirmed);
    const qcItems = (record.reviewedQcMismatches || []).filter((i) => i.confirmed);
    const detected = record.scannedScenarios || [];
    const selectedIds = record.scenarioIds ?? detected.map((s) => s.id);
    const selected = detected.filter((s) => selectedIds.includes(s.id));
    const regions = record.scanRegions || [];

    const scope: ReportScopeItem[] = [
        ...selected.map<ReportScopeItem>((s) => ({ kind: "scenario", sheet: s.sheet, label: s.scenarioLabel, range: scenarioRangeLabel(s), qc: true })),
        ...regions.map<ReportScopeItem>((r) => ({
            kind: "region",
            sheet: r.sheet,
            label: r.label || "Vùng tự chọn",
            range: cellRangeLabel(r.startRow, r.endRow, r.startCol, r.endCol),
            qc: r.qc !== false
        }))
    ];

    return {
        taskName: input.taskName,
        projectName: input.projectName ?? null,
        fileName: record.fileName ?? null,
        finalizedAt: record.finalizedAt ?? null,
        exportedAt: new Date(),
        sheetNames: record.sheetNames || [],
        scope,
        totalScenarios: detected.length,
        scannedScenarioCount: selected.length,
        regionCount: regions.length,
        spellTotal: spellItems.length,
        spellGroups: groupSpellErrors(spellItems),
        qcTotal: qcItems.length,
        qcGroups: groupQcMismatches(qcItems),
        qcSkippedReason: record.qcSkippedReason ?? null,
        products: input.products
    };
}
