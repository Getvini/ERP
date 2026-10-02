import ExcelJS from "exceljs";
import { excelRefToRowCol } from "./excelRef.helper";
import type { CheckReportData } from "./checkReportData.helper";

const SPELL_FILL = "FFFDE68A";
const SPELL_BORDER_COLOR = "FFEA580C";
const QC_FILL = "FFFEE2E2";
const QC_BORDER_COLOR = "FFDC2626";

const INK = "FF0F172A";
const BRAND = "FFF28C28";
const SLATE = "FF334155";
const BLUE = "FF2563EB";
const RED = "FFDC2626";
const GREEN = "FF16A34A";
const MUTED = "FF64748B";
const LINE = "FFE2E8F0";
const PANEL = "FFF8FAFC";

const SPELL_BORDER: Partial<ExcelJS.Border> = { style: "medium", color: { argb: SPELL_BORDER_COLOR } };
const QC_BORDER: Partial<ExcelJS.Border> = { style: "medium", color: { argb: QC_BORDER_COLOR } };
const MAX_NOTES = 400;

export type HighlightScenario = { id: string; colStart?: number | null; colWidth?: number | null };

function resolveSheet(workbook: ExcelJS.Workbook, sheetNames: string[], hint: string | null) {
    if (hint) {
        const bySheetName = workbook.getWorksheet(hint);
        if (bySheetName) return bySheetName;
    }
    if (sheetNames.length === 1) {
        const byRecordSheet = workbook.getWorksheet(sheetNames[0]);
        if (byRecordSheet) return byRecordSheet;
    }
    if (workbook.worksheets.length === 1) return workbook.worksheets[0];
    return null;
}

const hasSolidFill = (cell: ExcelJS.Cell) => {
    const fill: any = cell.fill;
    return Boolean(fill && fill.type === "pattern" && fill.pattern && fill.pattern !== "none");
};

function solid(argb: string): ExcelJS.Fill {
    return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function quoteSheet(name: string) {
    return `'${name.replace(/'/g, "''")}'`;
}

function estimateHeight(parts: { text: string; width: number }[], lineHeight = 15, min = 22) {
    let lines = 1;
    for (const part of parts) {
        const perLine = Math.max(Math.floor(part.width * 1.05), 8);
        const count = String(part.text || "")
            .split("\n")
            .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
        lines = Math.max(lines, count);
    }
    return Math.max(lines * lineHeight + 8, min);
}

type NoteKey = string;

function highlightDataSheets(
    workbook: ExcelJS.Workbook,
    sheetNames: string[],
    spellItems: { location: string; token: string }[],
    qcItems: (Record<string, any> & { sheet_name?: string })[],
    scenarios: HighlightScenario[]
) {
    const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
    const notes = new Map<NoteKey, { sheet: ExcelJS.Worksheet; row: number; col: number; lines: string[] }>();
    const addNote = (sheet: ExcelJS.Worksheet, row: number, col: number, line: string) => {
        const key = `${sheet.id}:${row}:${col}`;
        if (!notes.has(key)) notes.set(key, { sheet, row, col, lines: [] });
        const entry = notes.get(key)!;
        if (!entry.lines.includes(line)) entry.lines.push(line);
    };

    for (const item of qcItems) {
        const sheet = resolveSheet(workbook, sheetNames, item.sheet_name || null);
        if (!sheet) continue;
        const rowRange: number[] = Array.isArray(item.row_range) ? item.row_range : [item.row_range, item.row_range];
        const start = Number(rowRange[0]);
        const end = Number(rowRange[1] ?? rowRange[0]);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

        const scenario = scenarioById.get(item.blockId ?? item.id);
        let firstCol = 1;
        let lastCol = Math.max(sheet.columnCount, 1);
        if (scenario?.colWidth && scenario.colWidth > 0) {
            firstCol = (scenario.colStart ?? 0) + 1;
            lastCol = firstCol + scenario.colWidth - 1;
        }

        for (let r = start; r <= end; r++) {
            const row = sheet.getRow(r);
            for (let c = firstCol; c <= lastCol; c++) {
                const cell = row.getCell(c);
                if (!hasSolidFill(cell)) cell.fill = solid(QC_FILL);
                const border: Partial<ExcelJS.Borders> = { ...(cell.border || {}) };
                if (r === start) border.top = QC_BORDER;
                if (r === end) border.bottom = QC_BORDER;
                if (c === firstCol) border.left = QC_BORDER;
                if (c === lastCol) border.right = QC_BORDER;
                cell.border = border;
            }
        }

        const claimed = String(item.claimed_value ?? "(trống)");
        const expected = String(item.expected_value ?? "không tìm thấy");
        addNote(sheet, start, firstCol, `QC · ${item.attribute || "Thuộc tính"}\nGhi: ${claimed}\nChuẩn: ${expected}${item.product_ref ? `\nSản phẩm: ${item.product_ref}` : ""}`);
    }

    for (const item of spellItems) {
        const parsed = excelRefToRowCol(item.location);
        if (!parsed) continue;
        const sheet = resolveSheet(workbook, sheetNames, parsed.sheet);
        if (!sheet) continue;
        const cell = sheet.getRow(parsed.row).getCell(parsed.col);
        cell.fill = solid(SPELL_FILL);
        cell.border = { top: SPELL_BORDER, bottom: SPELL_BORDER, left: SPELL_BORDER, right: SPELL_BORDER };
        addNote(sheet, parsed.row, parsed.col, `Lỗi chính tả: ${item.token}`);
    }

    let count = 0;
    for (const entry of notes.values()) {
        if (count >= MAX_NOTES) break;
        // typings của exceljs 3.x chưa khai báo `note` dù runtime hỗ trợ ghi chú ô.
        (entry.sheet.getRow(entry.row).getCell(entry.col) as any).note = entry.lines.join("\n\n");
        count += 1;
    }
}

function addSummarySheet(workbook: ExcelJS.Workbook, data: CheckReportData) {
    const taken = new Set(workbook.worksheets.map((ws) => ws.name));
    const name = !taken.has("Tổng quan") ? "Tổng quan" : !taken.has("Báo cáo kiểm tra") ? "Báo cáo kiểm tra" : "Tổng quan (báo cáo)";
    const ws = workbook.addWorksheet(name, {
        properties: { tabColor: { argb: BRAND } },
        views: [{ showGridLines: false }],
        pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    });

    const widths = [5, 24, 34, 24, 28, 28, 46];
    widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
    const totalWidth = widths.reduce((a, b) => a + b, 0);
    const link = (sheet: string | null, ref: string | null) => (sheet && ref ? `#${quoteSheet(sheet)}!${ref}` : null);

    const band = (rowNo: number, text: string, opts: { size: number; bold?: boolean; color: string; height: number }) => {
        ws.mergeCells(rowNo, 1, rowNo, 7);
        const cell = ws.getCell(rowNo, 1);
        cell.value = text;
        cell.font = { name: "Calibri", size: opts.size, bold: opts.bold, color: { argb: opts.color } };
        cell.fill = solid(INK);
        cell.alignment = { vertical: "middle", indent: 1 };
        for (let c = 2; c <= 7; c++) ws.getCell(rowNo, c).fill = solid(INK);
        ws.getRow(rowNo).height = opts.height;
    };

    band(1, "BÁO CÁO KIỂM TRA KẾT QUẢ · CHÍNH TẢ & QC", { size: 10, bold: true, color: "FFFB923C", height: 26 });
    band(2, data.taskName || "(Không có tên công việc)", { size: 18, bold: true, color: "FFFFFFFF", height: 34 });
    const meta = [
        data.projectName ? `Dự án: ${data.projectName}` : null,
        data.fileName ? `File: ${data.fileName}` : null,
        data.finalizedAt ? `Chốt lúc: ${new Date(data.finalizedAt).toLocaleString("vi-VN", { hour12: false })}` : null,
        `Xuất lúc: ${data.exportedAt.toLocaleString("vi-VN", { hour12: false })}`
    ].filter(Boolean).join("   ·   ");
    band(3, meta, { size: 10, color: "FF94A3B8", height: 26 });
    ws.getRow(4).height = 12;

    // Thẻ thống kê (cột B..E)
    const cards = [
        { label: "LỖI CHÍNH TẢ", value: data.spellTotal, sub: `${data.spellGroups.length} từ/loại lỗi`, color: BLUE },
        { label: "ĐIỂM QC CHƯA KHỚP", value: data.qcTotal, sub: `${data.qcGroups.length} thuộc tính`, color: data.qcTotal > 0 ? RED : GREEN },
        { label: "SHEET ĐÃ QUÉT", value: data.sheetNames.length, sub: data.sheetNames.join(", ") || "-", color: BRAND },
        { label: "KỊCH BẢN / VÙNG", value: data.scannedScenarioCount + data.regionCount, sub: `${data.scannedScenarioCount} kịch bản · ${data.regionCount} vùng tự chọn`, color: SLATE }
    ];
    cards.forEach((card, i) => {
        const col = 2 + i;
        const top = ws.getCell(5, col);
        top.value = card.label;
        top.font = { name: "Calibri", size: 9, bold: true, color: { argb: MUTED } };
        const mid = ws.getCell(6, col);
        mid.value = card.value;
        mid.font = { name: "Calibri", size: 26, bold: true, color: { argb: card.color } };
        const sub = ws.getCell(7, col);
        sub.value = card.sub;
        sub.font = { name: "Calibri", size: 9, color: { argb: MUTED } };
        [top, mid, sub].forEach((cell, idx) => {
            cell.fill = solid(PANEL);
            cell.alignment = { vertical: "middle", horizontal: "left", indent: 1, wrapText: idx === 2 };
            cell.border = {
                top: idx === 0 ? { style: "thick", color: { argb: card.color } } : undefined,
                left: { style: "thick", color: { argb: "FFFFFFFF" } },
                right: { style: "thick", color: { argb: "FFFFFFFF" } }
            };
        });
    });
    ws.getRow(5).height = 22;
    ws.getRow(6).height = 40;
    ws.getRow(7).height = 30;
    ws.getRow(8).height = 12;

    ws.mergeCells(9, 1, 9, 7);
    const legend = ws.getCell(9, 1);
    legend.value = "Chú thích trên các sheet dữ liệu:  ô nền vàng + viền cam = lỗi chính tả  ·  vùng nền hồng + viền đỏ = dòng QC chưa khớp.  Rê chuột vào ô để xem ghi chú, bấm liên kết xanh ở bảng dưới để nhảy tới đúng ô.";
    legend.font = { name: "Calibri", size: 10, italic: true, color: { argb: MUTED } };
    legend.fill = solid(PANEL);
    legend.alignment = { vertical: "middle", wrapText: true, indent: 1 };
    ws.getRow(9).height = estimateHeight([{ text: legend.value as string, width: totalWidth - 4 }], 14, 30);

    let rowNo = 11;
    const sectionTitle = (title: string, right: string, color: string) => {
        ws.mergeCells(rowNo, 1, rowNo, 7);
        const cell = ws.getCell(rowNo, 1);
        cell.value = `${title}   ·   ${right}`;
        cell.font = { name: "Calibri", size: 13, bold: true, color: { argb: color } };
        cell.alignment = { vertical: "middle", indent: 0 };
        for (let c = 1; c <= 7; c++) ws.getCell(rowNo, c).border = { bottom: { style: "medium", color: { argb: color } } };
        ws.getRow(rowNo).height = 26;
        rowNo += 1;
    };
    const header = (labels: (string | null)[], color: string, merges: [number, number][] = []) => {
        labels.forEach((label, i) => {
            const cell = ws.getCell(rowNo, i + 1);
            cell.value = label ?? "";
            cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
            cell.fill = solid(color);
            cell.alignment = { vertical: "middle", horizontal: i === 0 ? "center" : "left", indent: i === 0 ? 0 : 1 };
        });
        merges.forEach(([a, b]) => ws.mergeCells(rowNo, a, rowNo, b));
        ws.getRow(rowNo).height = 22;
        rowNo += 1;
    };
    const dataRow = (
        values: (string | number | { text: string; hyperlink: string } | null)[],
        opts: { zebra: boolean; styles?: Record<number, Partial<ExcelJS.Font>>; merges?: [number, number][]; height: number }
    ) => {
        values.forEach((value, i) => {
            const cell = ws.getCell(rowNo, i + 1);
            cell.value = value as any;
            const isLink = typeof value === "object" && value !== null && "hyperlink" in value;
            cell.font = {
                name: "Calibri",
                size: 10,
                color: { argb: isLink ? BLUE : "FF1E293B" },
                underline: isLink,
                ...(opts.styles?.[i + 1] || {})
            } as ExcelJS.Font;
            if (opts.zebra) cell.fill = solid(PANEL);
            cell.alignment = { vertical: "top", horizontal: i === 0 ? "center" : "left", wrapText: true, indent: i === 0 ? 0 : 1 };
        });
        for (let c = 1; c <= 7; c++) ws.getCell(rowNo, c).border = { bottom: { style: "thin", color: { argb: LINE } } };
        (opts.merges || []).forEach(([a, b]) => ws.mergeCells(rowNo, a, rowNo, b));
        ws.getRow(rowNo).height = opts.height;
        rowNo += 1;
    };
    const emptyNote = (text: string, color: string) => {
        ws.mergeCells(rowNo, 1, rowNo, 7);
        const cell = ws.getCell(rowNo, 1);
        cell.value = text;
        cell.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: color } };
        cell.fill = solid(PANEL);
        cell.alignment = { vertical: "middle", indent: 1 };
        ws.getRow(rowNo).height = 28;
        rowNo += 2;
    };

    // 1. Phạm vi quét
    sectionTitle("1. Phạm vi quét", `${data.sheetNames.length} sheet`, "FFD97706");
    if (data.scope.length === 0) {
        emptyNote("Quét toàn bộ nội dung của các sheet đã chọn.", MUTED);
    } else {
        header(["#", "Sheet", "Tên", "Loại", "Phạm vi ô", "Đối chiếu QC", null], SLATE, [[6, 7]]);
        data.scope.forEach((item, idx) => {
            const first = item.range.split(":")[0];
            const target = link(item.sheet, /^[A-Za-z]+\d+$/.test(first) ? first : null);
            dataRow(
                [idx + 1, item.sheet, item.label, item.kind === "scenario" ? "Kịch bản" : "Vùng tự chọn", target ? { text: item.range, hyperlink: target } : item.range, item.qc ? "Có" : "Không", null],
                {
                    zebra: idx % 2 === 1,
                    merges: [[6, 7]],
                    styles: { 4: { bold: true, color: { argb: item.kind === "scenario" ? BLUE : "FFB45309" } } },
                    height: estimateHeight([{ text: item.label, width: widths[2] }, { text: item.sheet, width: widths[1] }])
                }
            );
        });
        rowNo += 1;
    }

    // 2. Lỗi chính tả
    sectionTitle("2. Lỗi chính tả đã xác nhận", `${data.spellTotal} lỗi · ${data.spellGroups.length} loại`, BLUE);
    if (data.spellGroups.length === 0) {
        emptyNote("✓  Không có lỗi chính tả nào được xác nhận.", GREEN);
    } else {
        header(["#", "Sheet", "Kịch bản / Vùng", "Từ lỗi", "Số lần", "Vị trí ô (bấm để nhảy tới ô)", null], BLUE, [[6, 7]]);
        data.spellGroups.forEach((group, idx) => {
            const locations = group.locations.join(", ");
            const target = link(group.sheetName, group.firstRef);
            dataRow(
                [idx + 1, group.sheetName || "-", group.scenarioLabel || "-", group.token, group.count, target ? { text: locations, hyperlink: target } : locations, null],
                {
                    zebra: idx % 2 === 1,
                    merges: [[6, 7]],
                    styles: { 4: { bold: true, color: { argb: RED } }, 5: { bold: true } },
                    height: estimateHeight([
                        { text: locations, width: widths[5] + widths[6] },
                        { text: group.scenarioLabel || "", width: widths[2] },
                        { text: group.sheetName || "", width: widths[1] }
                    ])
                }
            );
        });
        rowNo += 1;
    }

    // 3. QC
    sectionTitle("3. Điểm QC chưa khớp đã xác nhận", `${data.qcTotal} điểm · ${data.qcGroups.length} thuộc tính`, RED);
    if (data.qcSkippedReason) emptyNote(`QC chưa được quét: ${data.qcSkippedReason}`, "FFB45309");
    if (data.qcGroups.length === 0) {
        if (!data.qcSkippedReason) emptyNote("✓  Không có điểm chưa khớp nào được xác nhận.", GREEN);
    } else {
        header(["#", "Sheet", "Sản phẩm (bấm để tới dòng)", "Thuộc tính", "Ghi trong bảng", "Chuẩn", "Ghi chú"], "FFB91C1C");
        let n = 0;
        data.qcGroups.forEach((group) => {
            group.items.forEach((item) => {
                const where = item.scenario ? `${item.productRef}\n${item.scenario}` : item.productRef;
                const target = link(item.sheet, item.rowStart ? `A${item.rowStart}` : null);
                const rows = item.rowStart == null ? "" : item.rowStart === item.rowEnd ? `Dòng ${item.rowStart}` : `Dòng ${item.rowStart}–${item.rowEnd}`;
                const reasoning = [rows, item.reasoning].filter(Boolean).join(" · ");
                dataRow(
                    [++n, item.sheet || "-", target ? { text: where, hyperlink: target } : where, group.attribute, item.claimed || "(trống)", item.expected, reasoning || "-"],
                    {
                        zebra: n % 2 === 0,
                        styles: { 4: { bold: true }, 5: { bold: true, color: { argb: RED } }, 6: { bold: true, color: { argb: GREEN } }, 7: { color: { argb: MUTED } } },
                        height: estimateHeight([
                            { text: where, width: widths[2] },
                            { text: item.claimed, width: widths[4] },
                            { text: item.expected, width: widths[5] },
                            { text: reasoning, width: widths[6] }
                        ])
                    }
                );
            });
        });
    }

    return ws;
}

export async function buildHighlightedWorkbook(
    buffer: Buffer,
    sheetNames: string[],
    spellItems: { location: string; token: string }[],
    qcItems: (Record<string, any> & { sheet_name?: string })[],
    options: { report?: CheckReportData; scenarios?: HighlightScenario[] } = {}
): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);

    highlightDataSheets(workbook, sheetNames, spellItems, qcItems, options.scenarios || []);

    if (options.report) {
        const summary = addSummarySheet(workbook, options.report);
        // Đưa sheet tổng quan lên đầu và mở sẵn khi người dùng mở file.
        (summary as any).orderNo = -1;
        workbook.views = [{ activeTab: 0, firstSheet: 0, visibility: "visible", x: 0, y: 0, width: 20000, height: 12000 }] as any;
    }

    const out = await workbook.xlsx.writeBuffer();
    return Buffer.from(out);
}

