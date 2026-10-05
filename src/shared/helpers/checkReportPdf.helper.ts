import path from "path";
import PDFDocument from "pdfkit";
import { drawTable, PdfRow } from "./pdfTable.helper";
import { renderRichTextToPdf } from "./richTextPdf.helper";
import type { CheckReportData } from "./checkReportData.helper";

const FONT_REGULAR = path.join(__dirname, "../../../assets/fonts/DejaVuSans.ttf");
const FONT_BOLD = path.join(__dirname, "../../../assets/fonts/DejaVuSans-Bold.ttf");

const INK = "#0f172a";
const BRAND = "#f28c28";
const BLUE = "#2563eb";
const RED = "#dc2626";
const GREEN = "#16a34a";
const AMBER = "#b45309";
const MUTED = "#64748b";
const SOFT = "#94a3b8";
const BORDER = "#e2e8f0";
const PANEL = "#f8fafc";

const MARGIN = 40;
const MAX_LOCATIONS = 14;
const MAX_SCOPE_ROWS = 40;

const formatDateTime = (date: Date) => date.toLocaleString("vi-VN", { hour12: false });
const formatDate = (date: Date) => date.toLocaleDateString("vi-VN");

export function renderCheckReportPdf(data: CheckReportData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc: any = new PDFDocument({ margin: MARGIN, bufferPages: true, size: "A4" });
        doc.registerFont("Base", FONT_REGULAR);
        doc.registerFont("Base-Bold", FONT_BOLD);

        const chunks: Buffer[] = [];
        doc.on("data", (c: Buffer) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        const pageWidth = doc.page.width;
        const pageHeight = doc.page.height;
        const contentWidth = pageWidth - MARGIN * 2;
        const usableBottom = () => pageHeight - doc.page.margins.bottom - 30;

        const drawAccent = () => {
            doc.save();
            doc.rect(0, 0, pageWidth, 4).fill(BRAND);
            doc.restore();
        };
        doc.on("pageAdded", drawAccent);

        let y = 0;
        const nextPage = () => {
            doc.addPage();
            y = MARGIN + 6;
        };
        const ensureSpace = (height: number) => {
            if (y + height > usableBottom()) nextPage();
        };

        // ===== Banner đầu trang =====
        doc.rect(0, 0, pageWidth, 122).fill(INK);
        doc.rect(0, 0, pageWidth, 5).fill(BRAND);
        doc.font("Base-Bold").fontSize(8.5).fillColor("#fb923c").text("BÁO CÁO KIỂM TRA KẾT QUẢ", MARGIN, 30, { characterSpacing: 1.4, lineBreak: false });
        doc.font("Base-Bold").fontSize(21).fillColor("#ffffff").text("Chính tả & Đối chiếu QC", MARGIN, 46, { lineBreak: false });
        doc.font("Base").fontSize(10.5).fillColor("#cbd5e1").text(data.taskName || "(Không có tên công việc)", MARGIN, 77, {
            width: contentWidth - 130,
            lineBreak: false,
            ellipsis: true
        });
        const meta = [
            data.projectName ? `Dự án: ${data.projectName}` : null,
            data.fileName ? `File: ${data.fileName}` : null
        ].filter(Boolean).join("   ·   ");
        if (meta) {
            doc.font("Base").fontSize(8.5).fillColor(SOFT).text(meta, MARGIN, 97, { width: contentWidth, lineBreak: false, ellipsis: true });
        }
        if (data.finalizedAt) {
            const label = `ĐÃ CHỐT · ${formatDate(new Date(data.finalizedAt))}`;
            doc.font("Base-Bold").fontSize(8);
            const w = doc.widthOfString(label) + 22;
            doc.roundedRect(pageWidth - MARGIN - w, 28, w, 20, 10).fill(GREEN);
            doc.fillColor("#ffffff").text(label, pageWidth - MARGIN - w, 34.5, { width: w, align: "center", lineBreak: false });
        }

        // ===== Thẻ thống kê =====
        y = 142;
        const gap = 12;
        const cardW = (contentWidth - gap * 2) / 3;
        const cardH = 66;
        const cards = [
            { label: "Lỗi chính tả", value: String(data.spellTotal), sub: `${data.spellGroups.length} từ/loại lỗi`, color: BLUE },
            { label: "Điểm QC chưa khớp", value: String(data.qcTotal), sub: `${data.qcGroups.length} thuộc tính`, color: data.qcTotal > 0 ? RED : GREEN },
            {
                label: "Phạm vi đã quét",
                value: `${data.sheetNames.length} sheet`,
                sub: `${data.scannedScenarioCount} kịch bản · ${data.regionCount} vùng tự chọn`,
                color: BRAND
            }
        ];
        cards.forEach((card, i) => {
            const cx = MARGIN + i * (cardW + gap);
            doc.roundedRect(cx, y, cardW, cardH, 8).lineWidth(0.8).fillAndStroke("#ffffff", BORDER);
            doc.save();
            doc.roundedRect(cx, y, 5, cardH, 2).fill(card.color);
            doc.restore();
            doc.font("Base").fontSize(8.5).fillColor(MUTED).text(card.label.toUpperCase(), cx + 16, y + 11, { width: cardW - 24, lineBreak: false });
            doc.font("Base-Bold").fontSize(22).fillColor(card.color).text(card.value, cx + 16, y + 24, { width: cardW - 24, lineBreak: false });
            doc.font("Base").fontSize(8).fillColor(SOFT).text(card.sub, cx + 16, y + 52, { width: cardW - 24, lineBreak: false, ellipsis: true });
        });
        y += cardH + 26;

        const section = (title: string, color: string, right?: string) => {
            ensureSpace(70);
            doc.roundedRect(MARGIN, y, 4, 17, 2).fill(color);
            doc.font("Base-Bold").fontSize(12.5).fillColor(INK).text(title, MARGIN + 13, y + 1.5, { width: contentWidth - 120, lineBreak: false });
            if (right) {
                doc.font("Base-Bold").fontSize(8.5).fillColor(color).text(right, MARGIN, y + 4, { width: contentWidth, align: "right", lineBreak: false });
            }
            y += 28;
        };

        const note = (text: string, color: string, fill: string, icon = "") => {
            doc.font("Base").fontSize(9.5);
            const h = doc.heightOfString(`${icon}${text}`, { width: contentWidth - 28 }) + 20;
            ensureSpace(h + 8);
            doc.roundedRect(MARGIN, y, contentWidth, h, 6).fill(fill);
            doc.fillColor(color).text(`${icon}${text}`, MARGIN + 14, y + 10, { width: contentWidth - 28 });
            y += h + 14;
        };

        const onNewPage = () => MARGIN + 6;
        const columnsFor = (widths: number[]) => widths.map((w) => w * contentWidth);

        // ===== 1. Phạm vi quét =====
        section("Phạm vi quét", BRAND, `${data.sheetNames.length} sheet`);
        if (data.sheetNames.length > 0) {
            doc.font("Base-Bold").fontSize(8.5);
            let cx = MARGIN;
            const chipH = 19;
            data.sheetNames.forEach((name) => {
                const w = Math.min(doc.widthOfString(name) + 22, contentWidth);
                if (cx + w > MARGIN + contentWidth) {
                    cx = MARGIN;
                    y += chipH + 6;
                }
                ensureSpace(chipH + 6);
                doc.roundedRect(cx, y, w, chipH, 9.5).lineWidth(0.8).fillAndStroke("#fff7ed", "#fdba74");
                doc.fillColor("#9a3412").text(name, cx + 11, y + 5.5, { width: w - 22, lineBreak: false, ellipsis: true });
                cx += w + 6;
            });
            y += chipH + 14;
        }

        if (data.scope.length === 0) {
            note("Quét toàn bộ nội dung của các sheet đã chọn (không giới hạn theo kịch bản hay vùng).", MUTED, PANEL);
        } else {
            const rows: PdfRow[] = data.scope.slice(0, MAX_SCOPE_ROWS).map((item) => [
                { text: item.kind === "scenario" ? "Kịch bản" : "Vùng tự chọn", color: item.kind === "scenario" ? BLUE : AMBER, bold: true },
                item.sheet,
                item.label,
                { text: item.range, bold: true },
                { text: item.qc ? "Có" : "Không", color: item.qc ? GREEN : SOFT }
            ]);
            const cols = columnsFor([0.16, 0.19, 0.33, 0.16, 0.16]);
            y = drawTable(doc, {
                x: MARGIN,
                y,
                headerColor: "#334155",
                columns: [
                    { header: "Loại", width: cols[0] },
                    { header: "Sheet", width: cols[1] },
                    { header: "Tên", width: cols[2] },
                    { header: "Phạm vi ô", width: cols[3] },
                    { header: "QC", width: cols[4], align: "center" }
                ],
                rows,
                onNewPage
            }) + 6;
            if (data.scope.length > MAX_SCOPE_ROWS) {
                doc.font("Base").fontSize(8.5).fillColor(MUTED).text(`… và ${data.scope.length - MAX_SCOPE_ROWS} mục khác`, MARGIN, y, { lineBreak: false });
                y += 14;
            }
            y += 14;
        }

        // ===== 2. Lỗi chính tả =====
        section("Lỗi chính tả đã xác nhận", BLUE, `${data.spellTotal} lỗi · ${data.spellGroups.length} loại`);
        if (data.spellGroups.length === 0) {
            note("Không có lỗi chính tả nào được xác nhận.", "#166534", "#f0fdf4", "✓  ");
        } else {
            const cols = columnsFor([0.06, 0.19, 0.1, 0.3, 0.35]);
            const rows: PdfRow[] = data.spellGroups.map((group, index) => {
                const shown = group.locations.slice(0, MAX_LOCATIONS).join(", ");
                const extra = group.locations.length > MAX_LOCATIONS ? `  +${group.locations.length - MAX_LOCATIONS} ô khác` : "";
                return [
                    { text: String(index + 1), color: SOFT },
                    { text: group.token, color: RED, bold: true },
                    { text: String(group.count), bold: true },
                    [group.sheetName, group.scenarioLabel].filter(Boolean).join(" / ") || "-",
                    `${shown}${extra}`
                ];
            });
            y = drawTable(doc, {
                x: MARGIN,
                y,
                headerColor: BLUE,
                columns: [
                    { header: "#", width: cols[0] },
                    { header: "Từ lỗi", width: cols[1] },
                    { header: "Số lần", width: cols[2], align: "center" },
                    { header: "Sheet / Kịch bản", width: cols[3] },
                    { header: "Vị trí ô", width: cols[4] }
                ],
                rows,
                onNewPage
            }) + 24;
        }

        // ===== 3. QC =====
        section("Điểm QC chưa khớp đã xác nhận", RED, `${data.qcTotal} điểm · ${data.qcGroups.length} thuộc tính`);
        if (data.qcSkippedReason) {
            note(`QC chưa được quét: ${data.qcSkippedReason}`, AMBER, "#fffbeb", "!  ");
        }
        if (data.qcGroups.length === 0) {
            if (!data.qcSkippedReason) note("Không có điểm chưa khớp nào được xác nhận.", "#166534", "#f0fdf4", "✓  ");
        } else {
            const cols = columnsFor([0.3, 0.2, 0.2, 0.3]);
            const rows: PdfRow[] = data.qcGroups.flatMap<PdfRow>((group) => [
                { group: group.attribute, color: RED, badge: `${group.items.length} điểm` },
                ...group.items.map<PdfRow>((item) => {
                    const where = [item.sheet, item.scenario].filter(Boolean).join(" / ");
                    const rowLabel = item.rowStart == null ? "" : item.rowStart === item.rowEnd ? `dòng ${item.rowStart}` : `dòng ${item.rowStart}–${item.rowEnd}`;
                    const sub = [where, rowLabel].filter(Boolean).join(" · ");
                    return [
                        { text: item.productRef, bold: true, sub: sub || undefined },
                        { text: item.claimed || "(trống)", color: RED, bold: true },
                        { text: item.expected, color: GREEN, bold: true },
                        { text: item.reasoning || "-", color: MUTED }
                    ];
                })
            ]);
            y = drawTable(doc, {
                x: MARGIN,
                y,
                headerColor: "#b91c1c",
                columns: [
                    { header: "Sản phẩm / Vị trí", width: cols[0] },
                    { header: "Ghi trong bảng", width: cols[1] },
                    { header: "Chuẩn", width: cols[2] },
                    { header: "Ghi chú", width: cols[3] }
                ],
                rows,
                onNewPage
            }) + 24;
        }

        // ===== Phụ lục: thông tin chuẩn sản phẩm =====
        ensureSpace(220);
        section("Phụ lục · Thông tin chuẩn sản phẩm", GREEN, `${data.products.length} sản phẩm`);
        if (data.products.length === 0) {
            note("Không có thông tin chuẩn sản phẩm.", MUTED, PANEL);
        } else {
            data.products.forEach((item, index) => {
                ensureSpace(90);
                doc.roundedRect(MARGIN, y, contentWidth, 24, 5).fill(PANEL);
                doc.rect(MARGIN, y, 3, 24).fill(GREEN);
                doc.font("Base-Bold").fontSize(10.5).fillColor(INK).text(`${index + 1}. ${item.productName || "(Không có tên sản phẩm)"}`, MARGIN + 14, y + 7, {
                    width: contentWidth - 24,
                    lineBreak: false,
                    ellipsis: true
                });
                y += 32;
                doc.y = y;
                renderRichTextToPdf(doc, item.extractedText || "", MARGIN + 6, contentWidth - 12, 9.5);
                if (item.note) {
                    doc.moveDown(0.2);
                    doc.font("Base").fontSize(9).fillColor(SOFT).text(`Ghi chú: ${item.note}`, MARGIN + 6, doc.y, { width: contentWidth - 12 });
                }
                y = doc.y + 18;
            });
        }

        // ===== Footer mọi trang =====
        const range = doc.bufferedPageRange();
        const exportedLabel = `Xuất lúc ${formatDateTime(data.exportedAt)}`;
        for (let i = range.start; i < range.start + range.count; i++) {
            doc.switchToPage(i);
            const savedBottom = doc.page.margins.bottom;
            doc.page.margins.bottom = 0;
            const fy = pageHeight - 34;
            doc.moveTo(MARGIN, fy).lineTo(pageWidth - MARGIN, fy).lineWidth(0.5).strokeColor(BORDER).stroke();
            doc.font("Base").fontSize(8).fillColor(SOFT).text(`${exportedLabel}  ·  ${data.taskName}`, MARGIN, fy + 8, {
                width: contentWidth - 80,
                lineBreak: false,
                ellipsis: true
            });
            doc.font("Base-Bold").fontSize(8).fillColor(MUTED).text(`Trang ${i + 1 - range.start}/${range.count}`, MARGIN, fy + 8, {
                width: contentWidth,
                align: "right",
                lineBreak: false
            });
            doc.page.margins.bottom = savedBottom;
        }

        doc.end();
    });
}
