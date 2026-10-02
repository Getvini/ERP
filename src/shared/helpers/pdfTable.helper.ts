export interface PdfTableColumn {
    header: string;
    width: number;
    align?: "left" | "center" | "right";
}

export type PdfCellStyle = { text: string; color?: string; bold?: boolean; sub?: string };
export type PdfCell = string | PdfCellStyle;
export type PdfGroupRow = { group: string; color: string; badge?: string };
export type PdfRow = PdfCell[] | PdfGroupRow;

const PADDING_X = 7;
const PADDING_Y = 6;
const HEADER_HEIGHT = 24;
const GROUP_HEIGHT = 24;
const TEXT_COLOR = "#1e293b";
const BORDER_COLOR = "#e2e8f0";
const ZEBRA_COLOR = "#f8fafc";
const FONT = "Base";
const FONT_BOLD = "Base-Bold";
const FONT_SIZE = 9;
const SUB_FONT_SIZE = 8;

const isGroupRow = (row: PdfRow): row is PdfGroupRow => !Array.isArray(row);
const cellText = (cell: PdfCell | undefined) => (cell === undefined ? "" : typeof cell === "string" ? cell : cell.text);
const cellStyle = (cell: PdfCell | undefined): PdfCellStyle => (typeof cell === "object" && cell ? cell : { text: cellText(cell) });

function measureRowHeight(doc: any, cells: PdfCell[], columns: PdfTableColumn[]) {
    let max = 0;
    columns.forEach((col, i) => {
        const style = cellStyle(cells[i]);
        const width = col.width - PADDING_X * 2;
        let h = doc.font(style.bold ? FONT_BOLD : FONT).fontSize(FONT_SIZE).heightOfString(style.text || "", { width });
        if (style.sub) h += 3 + doc.font(FONT).fontSize(SUB_FONT_SIZE).heightOfString(style.sub, { width });
        if (h > max) max = h;
    });
    return Math.max(max + PADDING_Y * 2, 22);
}

function drawHeader(doc: any, x: number, y: number, columns: PdfTableColumn[], headerColor: string) {
    const totalWidth = columns.reduce((sum, c) => sum + c.width, 0);
    doc.roundedRect(x, y, totalWidth, HEADER_HEIGHT, 4).fill(headerColor);
    let cx = x;
    columns.forEach((col) => {
        doc
            .fillColor("#ffffff")
            .font(FONT_BOLD)
            .fontSize(9)
            .text(col.header, cx + PADDING_X, y + 7.5, {
                width: col.width - PADDING_X * 2,
                align: col.align || "left",
                lineBreak: false
            });
        cx += col.width;
    });
    doc.fillColor(TEXT_COLOR);
    return y + HEADER_HEIGHT + 2;
}

function drawGroupRow(doc: any, x: number, y: number, totalWidth: number, row: PdfGroupRow) {
    doc.save();
    doc.rect(x, y, totalWidth, GROUP_HEIGHT).fillOpacity(0.1).fill(row.color);
    doc.restore();
    doc.rect(x, y, 3, GROUP_HEIGHT).fill(row.color);
    doc.fillColor(row.color).font(FONT_BOLD).fontSize(9.5).text(row.group, x + 12, y + 7.5, {
        width: totalWidth - 90,
        lineBreak: false,
        ellipsis: true
    });
    if (row.badge) {
        doc.font(FONT_BOLD).fontSize(8.5).text(row.badge, x, y + 8, { width: totalWidth - 10, align: "right", lineBreak: false });
    }
    doc.fillColor(TEXT_COLOR);
}

/**
 * Vẽ bảng có header bo góc, hàng zebra, đường kẻ ngang mảnh, hỗ trợ:
 *  - ô có màu/đậm riêng ({ text, color, bold })
 *  - hàng tiêu đề nhóm ({ group, color, badge })
 *  - tự ngắt trang và vẽ lại header ở trang mới
 */
export function drawTable(
    doc: any,
    opts: {
        x: number;
        y: number;
        columns: PdfTableColumn[];
        rows: PdfRow[];
        headerColor: string;
        onNewPage?: () => number;
    }
) {
    const { x, columns, rows, headerColor } = opts;
    const totalWidth = columns.reduce((sum, c) => sum + c.width, 0);
    const bottomLimit = doc.page.height - doc.page.margins.bottom - 8;

    const newPage = () => {
        doc.addPage();
        return opts.onNewPage ? opts.onNewPage() : doc.page.margins.top + 8;
    };

    let y = opts.y;
    if (y + HEADER_HEIGHT + 40 > bottomLimit) y = newPage();
    y = drawHeader(doc, x, y, columns, headerColor);

    let zebra = 0;
    rows.forEach((row, idx) => {
        if (isGroupRow(row)) {
            const next = rows[idx + 1];
            const nextHeight = next && !isGroupRow(next) ? measureRowHeight(doc, next, columns) : 0;
            if (y + GROUP_HEIGHT + nextHeight > bottomLimit) {
                y = newPage();
                y = drawHeader(doc, x, y, columns, headerColor);
            }
            drawGroupRow(doc, x, y, totalWidth, row);
            y += GROUP_HEIGHT;
            zebra = 0;
            return;
        }

        const rowHeight = measureRowHeight(doc, row, columns);
        if (y + rowHeight > bottomLimit) {
            y = newPage();
            y = drawHeader(doc, x, y, columns, headerColor);
        }

        if (zebra % 2 === 1) doc.rect(x, y, totalWidth, rowHeight).fill(ZEBRA_COLOR);
        zebra += 1;

        let cx = x;
        columns.forEach((col, i) => {
            const style = cellStyle(row[i]);
            doc
                .fillColor(style.color || TEXT_COLOR)
                .font(style.bold ? FONT_BOLD : FONT)
                .fontSize(FONT_SIZE)
                .text(style.text || "", cx + PADDING_X, y + PADDING_Y, {
                    width: col.width - PADDING_X * 2,
                    align: col.align || "left"
                });
            if (style.sub) {
                const mainHeight = doc.font(style.bold ? FONT_BOLD : FONT).fontSize(FONT_SIZE).heightOfString(style.text || "", { width: col.width - PADDING_X * 2 });
                doc.fillColor("#64748b").font(FONT).fontSize(SUB_FONT_SIZE).text(style.sub, cx + PADDING_X, y + PADDING_Y + mainHeight + 3, {
                    width: col.width - PADDING_X * 2,
                    align: col.align || "left"
                });
            }
            cx += col.width;
        });

        doc.moveTo(x, y + rowHeight).lineTo(x + totalWidth, y + rowHeight).lineWidth(0.5).strokeColor(BORDER_COLOR).stroke();
        y += rowHeight;
    });

    doc.fillColor(TEXT_COLOR);
    return y;
}
