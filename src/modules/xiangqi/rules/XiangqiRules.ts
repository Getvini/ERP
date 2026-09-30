/**
 * Luật cờ tướng thuần logic (không phụ thuộc DOM/Node/DB).
 * Toạ độ: hàng r = 0..9 (0 là phía Đen, 9 là phía Đỏ), cột c = 0..8.
 * Quân: 'rK' = Tướng Đỏ ... K tướng, A sĩ, E tượng, R xe, H mã, C pháo, P tốt.
 * File này được đồng bộ sang erp-UI (src/games/xiangqi/rules.js) bằng scripts/sync-xiangqi-rules.mjs.
 */
export type Color = "r" | "b";
export type Cell = string | null;
export type Board = Cell[][];
export interface Move { fr: number; fc: number; tr: number; tc: number }

const D4: number[][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DG: number[][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export const other = (c: Color): Color => (c === "r" ? "b" : "r");
export const inBoard = (r: number, c: number) => r >= 0 && r < 10 && c >= 0 && c < 9;

export function initialBoard(): Board {
    const b: Board = Array.from({ length: 10 }, () => Array(9).fill(null));
    "RHEAKAEHR".split("").forEach((t, c) => { b[0][c] = "b" + t; b[9][c] = "r" + t; });
    [1, 7].forEach((c) => { b[2][c] = "bC"; b[7][c] = "rC"; });
    [0, 2, 4, 6, 8].forEach((c) => { b[3][c] = "bP"; b[6][c] = "rP"; });
    return b;
}

/** Nước đi "giả hợp lệ" của một quân (chưa loại nước làm tướng mình bị chiếu). */
export function genPiece(b: Board, r: number, c: number): number[][] {
    const p = b[r][c] as string;
    const col = p[0];
    const t = p[1];
    const out: number[][] = [];
    const add = (y: number, x: number) => {
        if (inBoard(y, x) && (!b[y][x] || (b[y][x] as string)[0] !== col)) out.push([y, x]);
    };
    const palace = (y: number, x: number) =>
        x >= 3 && x <= 5 && (col === "r" ? y >= 7 && y <= 9 : y >= 0 && y <= 2);

    if (t === "K") D4.forEach(([a, d]) => palace(r + a, c + d) && add(r + a, c + d));
    if (t === "A") DG.forEach(([a, d]) => palace(r + a, c + d) && add(r + a, c + d));
    if (t === "E") {
        DG.forEach(([a, d]) => {
            const y = r + 2 * a;
            const x = c + 2 * d;
            if (inBoard(y, x) && !b[r + a][c + d] && (col === "r" ? y >= 5 : y <= 4)) add(y, x);
        });
    }
    if (t === "H") {
        D4.forEach(([a, d]) => {
            if (inBoard(r + a, c + d) && !b[r + a][c + d]) {
                const targets = a ? [[2 * a, -1], [2 * a, 1]] : [[-1, 2 * d], [1, 2 * d]];
                targets.forEach(([e, f]) => add(r + e, c + f));
            }
        });
    }
    if (t === "R" || t === "C") {
        D4.forEach(([a, d]) => {
            let y = r + a;
            let x = c + d;
            let jumped = false;
            while (inBoard(y, x)) {
                const q = b[y][x];
                if (!jumped) {
                    if (!q) out.push([y, x]);
                    else if (t === "R") { if (q[0] !== col) out.push([y, x]); break; }
                    else jumped = true;
                } else if (q) {
                    if (q[0] !== col) out.push([y, x]);
                    break;
                }
                y += a;
                x += d;
            }
        });
    }
    if (t === "P") {
        const f = col === "r" ? -1 : 1;
        add(r + f, c);
        if (col === "r" ? r <= 4 : r >= 5) { add(r, c + 1); add(r, c - 1); }
    }
    return out;
}

export function isInCheck(b: Board, col: Color): boolean {
    const e = other(col);
    let kr = -1, kc = -1, er = -1, ec = -1;
    for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 9; c++) {
            if (b[r][c] === col + "K") { kr = r; kc = c; }
            if (b[r][c] === e + "K") { er = r; ec = c; }
        }
    }
    if (kr < 0) return true; // tướng đã mất
    if (er >= 0 && kc === ec) { // hai tướng đối mặt
        let n = 0;
        for (let y = Math.min(kr, er) + 1; y < Math.max(kr, er); y++) if (b[y][kc]) n++;
        if (!n) return true;
    }
    for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 9; c++) {
            const p = b[r][c];
            if (p && p[0] === e && genPiece(b, r, c).some((m) => m[0] === kr && m[1] === kc)) return true;
        }
    }
    return false;
}

export function applyMove(b: Board, m: Move): Board {
    const n = b.map((row) => row.slice());
    n[m.tr][m.tc] = n[m.fr][m.fc];
    n[m.fr][m.fc] = null;
    return n;
}

export function legalMoves(b: Board, col: Color): Move[] {
    const list: Move[] = [];
    for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 9; c++) {
            const p = b[r][c];
            if (!p || p[0] !== col) continue;
            genPiece(b, r, c).forEach(([y, x]) => {
                const m = { fr: r, fc: c, tr: y, tc: x };
                if (!isInCheck(applyMove(b, m), col)) list.push(m);
            });
        }
    }
    return list;
}

export function isLegalMove(b: Board, col: Color, m: Move): boolean {
    if (![m?.fr, m?.fc, m?.tr, m?.tc].every((n) => Number.isInteger(n))) return false;
    if (!inBoard(m.fr, m.fc) || !inBoard(m.tr, m.tc)) return false;
    const p = b[m.fr][m.fc];
    if (!p || p[0] !== col) return false;
    return legalMoves(b, col).some((x) => x.fr === m.fr && x.fc === m.fc && x.tr === m.tr && x.tc === m.tc);
}

export const positionKey = (b: Board, turn: Color) =>
    b.map((row) => row.map((p) => p || "..").join("")).join("/") + turn;

/**
 * Xử lý lặp thế. keys[i]/checks[i] là thế cờ sau nước thứ i (i = 0 là thế ban đầu, Đỏ đi trước);
 * checks[i] = nước thứ i có chiếu đối phương hay không.
 * Thế lặp lần 3: bên chiếu liên tục suốt chu kỳ bị xử thua; cả hai cùng chiếu hoặc không ai chiếu -> hòa.
 * (Luật "đuổi liên tục" chưa được cài đặt.)
 */
export function repetitionResult(keys: string[], checks: boolean[]):
    null | { result: "red" | "black" | "draw"; reason: string } {
    const i = keys.length - 1;
    if (i < 8) return null;
    const idx: number[] = [];
    keys.forEach((k, j) => { if (k === keys[i]) idx.push(j); });
    if (idx.length < 3) return null;
    let redAlways = true, blackAlways = true;
    for (let j = idx[idx.length - 3] + 1; j <= i; j++) {
        if (!checks[j]) { if (j % 2) redAlways = false; else blackAlways = false; }
    }
    if (redAlways && !blackAlways) return { result: "black", reason: "perpetual_check" };
    if (blackAlways && !redAlways) return { result: "red", reason: "perpetual_check" };
    return { result: "draw", reason: "repetition" };
}

/** Kết quả sau một nước đi: bên tới lượt hết nước đi (chiếu bí hoặc hết nước) thì thua. */
export function outcomeAfterMove(b: Board, next: Color):
    null | { result: "red" | "black"; reason: "checkmate" | "stalemate" } {
    if (legalMoves(b, next).length) return null;
    return {
        result: next === "r" ? "black" : "red",
        reason: isInCheck(b, next) ? "checkmate" : "stalemate",
    };
}

/** Hòa do thiếu lực lượng: không còn quân nào có thể tạo chiếu bí (chỉ còn tướng, sĩ, tượng). */
export function insufficientMaterial(b: Board): boolean {
    for (const row of b) for (const p of row) if (p && !"KAE".includes(p[1])) return false;
    return true;
}

// --- Dùng cho bot phía client (chế độ luyện tập). Server không dùng phần này. ---
const VAL: Record<string, number> = { K: 0, R: 9, H: 4, C: 4.5, E: 2, A: 2, P: 1 };
export function evaluate(b: Board): number {
    let s = 0;
    for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 9; c++) {
            const p = b[r][c];
            if (!p) continue;
            let v = VAL[p[1]];
            if (p[1] === "P" && (p[0] === "r" ? r <= 4 : r >= 5)) v += 1;
            v += (4 - Math.abs(4 - c)) * 0.05;
            s += p[0] === "r" ? v : -v;
        }
    }
    return s;
}
export function search(b: Board, col: Color, d: number, al: number, be: number): number {
    if (!d) return evaluate(b);
    const L = legalMoves(b, col);
    if (!L.length) return col === "r" ? -999 - d : 999 + d;
    L.sort((x, y) => Number(!!b[y.tr][y.tc]) - Number(!!b[x.tr][x.tc]));
    let v = col === "r" ? -1e5 : 1e5;
    for (const m of L) {
        const s = search(applyMove(b, m), other(col), d - 1, al, be);
        if (col === "r") { v = Math.max(v, s); al = Math.max(al, v); } else { v = Math.min(v, s); be = Math.min(be, v); }
        if (al >= be) break;
    }
    return v;
}
export function bestBotMove(b: Board, col: Color, depth: number): Move | null {
    let best: Move | null = null;
    let bv = col === "b" ? 1e5 : -1e5;
    for (const m of legalMoves(b, col)) {
        const s = search(applyMove(b, m), other(col), depth, -1e5, 1e5) + (Math.random() - 0.5) * 0.2;
        if (col === "b" ? s < bv : s > bv) { bv = s; best = m; }
    }
    return best;
}
