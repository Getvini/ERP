/**
 * Vini Tactics — dữ liệu tĩnh. Đây là NGUỒN DUY NHẤT: client nhận catalog qua socket (tft:sync),
 * không có bản sao ở frontend nên không lo lệch số liệu.
 */
export type SpellType = "aoe" | "stun" | "heal" | "buff" | "shield";
export type TraitId = "sales" | "production" | "qc" | "finance";

export interface UnitDef {
    key: string; name: string; emoji: string; cost: number; trait: TraitId;
    hp: number; atk: number; range: number;
    atkInt: number;              // số tick giữa 2 đòn đánh (1 tick = 100ms)
    mana: number;                // mana cần để tung chiêu
    spell: { type: SpellType; v: number; dur?: number; text: string };
}

export interface TraitDef {
    id: TraitId; name: string; emoji: string; desc: string;
    thresholds: number[];
    kind: "atkPct" | "hpPct" | "spdPct" | "startMana";
    scope: "members" | "all";
    values: number[];
}

export const TRAITS: TraitDef[] = [
    { id: "sales", name: "Kinh doanh", emoji: "📈", desc: "Thành viên +sát thương", thresholds: [2, 4], kind: "atkPct", scope: "members", values: [0.25, 0.6] },
    { id: "production", name: "Sản xuất", emoji: "🏭", desc: "Thành viên +máu", thresholds: [2, 4], kind: "hpPct", scope: "members", values: [0.3, 0.7] },
    { id: "qc", name: "QC", emoji: "🔍", desc: "Thành viên đánh nhanh hơn", thresholds: [2, 3], kind: "spdPct", scope: "members", values: [0.25, 0.55] },
    { id: "finance", name: "Tài chính", emoji: "💰", desc: "Cả đội +mana khởi đầu", thresholds: [2], kind: "startMana", scope: "all", values: [40] },
];

export const UNITS: UnitDef[] = [
    // --- 1 vàng ---
    { key: "sr", name: "Sales Rep", emoji: "💼", cost: 1, trait: "sales", hp: 560, atk: 45, range: 1, atkInt: 10, mana: 60, spell: { type: "shield", v: 150, text: "Khiên 150 cho bản thân và đồng đội kề bên" } },
    { key: "ed", name: "Editor", emoji: "🎬", cost: 1, trait: "production", hp: 500, atk: 50, range: 1, atkInt: 10, mana: 70, spell: { type: "aoe", v: 90, text: "Gây 90 sát thương vùng quanh mục tiêu" } },
    { key: "ts", name: "Tester", emoji: "🧪", cost: 1, trait: "qc", hp: 420, atk: 55, range: 2, atkInt: 10, mana: 80, spell: { type: "stun", v: 60, dur: 20, text: "Gây 60 sát thương và làm choáng 2 giây" } },
    // --- 2 vàng ---
    { key: "am", name: "Account", emoji: "🤝", cost: 2, trait: "sales", hp: 640, atk: 60, range: 1, atkInt: 10, mana: 70, spell: { type: "buff", v: 0.3, dur: 50, text: "Cả đội +30% sát thương trong 5 giây" } },
    { key: "dg", name: "Designer", emoji: "🎨", cost: 2, trait: "production", hp: 560, atk: 65, range: 2, atkInt: 10, mana: 80, spell: { type: "aoe", v: 140, text: "Gây 140 sát thương vùng quanh mục tiêu" } },
    { key: "rv", name: "Reviewer", emoji: "📝", cost: 2, trait: "qc", hp: 520, atk: 70, range: 3, atkInt: 10, mana: 90, spell: { type: "stun", v: 90, dur: 20, text: "Gây 90 sát thương và làm choáng 2 giây" } },
    { key: "ac", name: "Kế toán", emoji: "🧮", cost: 2, trait: "finance", hp: 500, atk: 50, range: 2, atkInt: 10, mana: 60, spell: { type: "heal", v: 160, text: "Hồi 160 máu cho đồng đội yếu nhất" } },
    // --- 3 vàng ---
    { key: "bd", name: "BD Lead", emoji: "🚀", cost: 3, trait: "sales", hp: 820, atk: 80, range: 1, atkInt: 10, mana: 80, spell: { type: "shield", v: 300, text: "Khiên 300 cho bản thân và đồng đội kề bên" } },
    { key: "ai", name: "AI Artist", emoji: "🤖", cost: 3, trait: "production", hp: 640, atk: 85, range: 3, atkInt: 10, mana: 90, spell: { type: "aoe", v: 220, text: "Gây 220 sát thương vùng quanh mục tiêu" } },
    { key: "qa", name: "QC Lead", emoji: "🛡️", cost: 3, trait: "qc", hp: 760, atk: 90, range: 2, atkInt: 10, mana: 100, spell: { type: "stun", v: 140, dur: 25, text: "Gây 140 sát thương và làm choáng 2,5 giây" } },
    // --- 4 vàng ---
    { key: "cfo", name: "CFO", emoji: "🏦", cost: 4, trait: "finance", hp: 820, atk: 75, range: 3, atkInt: 10, mana: 90, spell: { type: "heal", v: 280, text: "Hồi 280 máu cho đồng đội yếu nhất" } },
    { key: "dir", name: "GĐ Sản xuất", emoji: "🏭", cost: 4, trait: "production", hp: 1100, atk: 110, range: 1, atkInt: 10, mana: 100, spell: { type: "aoe", v: 300, text: "Gây 300 sát thương vùng quanh mục tiêu" } },
    // --- 5 vàng ---
    { key: "ceo", name: "CEO", emoji: "👑", cost: 5, trait: "sales", hp: 1300, atk: 140, range: 2, atkInt: 10, mana: 110, spell: { type: "buff", v: 0.5, dur: 60, text: "Cả đội +50% sát thương trong 6 giây" } },
];

export const UNIT_MAP: Record<string, UnitDef> = Object.fromEntries(UNITS.map((u) => [u.key, u]));
export const TRAIT_MAP: Record<string, TraitDef> = Object.fromEntries(TRAITS.map((t) => [t.id, t]));

export const C = {
    BOARD_COLS: 5, BOARD_ROWS: 3, BENCH: 8, SHOP_SIZE: 5,
    START_LEVEL: 3, MAX_LEVEL: 7, LIVES: 3, TOTAL_ROUNDS: 12,
    START_GOLD: 5, BASE_INCOME: 5, REROLL_COST: 2, XP_COST: 4, XP_PER_BUY: 4, XP_PER_ROUND: 2,
    XP_NEED: { 3: 6, 4: 10, 5: 16, 6: 24 } as Record<number, number>,
    // tỉ lệ (%) ra quân giá 1..5 theo cấp
    SHOP_ODDS: {
        3: [75, 25, 0, 0, 0], 4: [60, 33, 7, 0, 0], 5: [40, 40, 18, 2, 0],
        6: [25, 38, 28, 8, 1], 7: [15, 30, 32, 18, 5],
    } as Record<number, number[]>,
    HP_STAR: [1, 1.8, 3.2], ATK_STAR: [1, 1.6, 2.6], SPELL_STAR: [1, 1.5, 2.2],
};

export const CATALOG = { units: UNITS, traits: TRAITS, consts: {
    boardCols: C.BOARD_COLS, boardRows: C.BOARD_ROWS, bench: C.BENCH, shopSize: C.SHOP_SIZE,
    maxLevel: C.MAX_LEVEL, lives: C.LIVES, totalRounds: C.TOTAL_ROUNDS,
    rerollCost: C.REROLL_COST, xpCost: C.XP_COST, xpNeed: C.XP_NEED,
} };

// ---------- PRNG có seed (xác định, không phụ thuộc Math.random) ----------
export function hashSeed(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}
export function mulberry32(a: number) {
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------- trait ----------
export interface ActiveTrait { id: TraitId; count: number; tier: number }

/** Đếm theo quân KHÁC NHAU (2 Editor vẫn chỉ tính 1). */
export function activeTraits(keys: string[]): ActiveTrait[] {
    const uniq = new Set(keys);
    const counts: Partial<Record<TraitId, number>> = {};
    uniq.forEach((k) => { const u = UNIT_MAP[k]; if (u) counts[u.trait] = (counts[u.trait] || 0) + 1; });
    return TRAITS.map((t) => {
        const count = counts[t.id] || 0;
        let tier = -1;
        t.thresholds.forEach((th, i) => { if (count >= th) tier = i; });
        return { id: t.id, count, tier };
    }).filter((a) => a.count > 0);
}

export const sellValue = (key: string, star: number) =>
    UNIT_MAP[key].cost * Math.pow(3, star - 1) - (star > 1 ? 1 : 0);
