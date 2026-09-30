import { C, SpellType, TRAIT_MAP, UNIT_MAP, activeTraits } from "./TftData";

/**
 * Mô phỏng 1 trận. HÀM THUẦN, KHÔNG dùng random: cùng đầu vào => cùng kết quả.
 * Sân 5 cột x 6 hàng: hàng 0-2 là phe địch (hàng 2 sát giữa), hàng 3-5 là phe ta (hàng 3 sát giữa).
 * Toạ độ đầu vào là toạ độ "cục bộ" của mỗi phe: r=0 là hàng tiền tuyến, r=2 là hàng sau cùng.
 * 1 tick = 100ms. Chi phí ~ vài ms/trận, không có vòng lặp nền nào trên server.
 */
export interface Placement { key: string; star: number; r: number; c: number }
export interface BattleUnit { id: number; side: "p" | "e"; key: string; star: number; r: number; c: number; maxHp: number }

export type BattleEvent =
    | { t: number; e: "m"; id: number; r: number; c: number }                                  // di chuyển
    | { t: number; e: "a"; id: number; tg: number; dmg: number; hp: number }                   // đánh thường
    | { t: number; e: "s"; id: number; sp: SpellType; tg: number[]; v: number; hp: number[] }  // chiêu thức
    | { t: number; e: "d"; id: number };                                                       // chết

export interface BattleResult {
    winner: "p" | "e" | "draw";
    ticks: number;
    units: BattleUnit[];
    events: BattleEvent[];
    left: { p: number; e: number };
}

const COLS = C.BOARD_COLS;
const ROWS = C.BOARD_ROWS * 2;
export const MAX_TICKS = 400;    // 40 giây, quá giờ thì so máu còn lại
const MOVE_TICKS = 4;            // 1 ô / 0,4 giây

interface U {
    id: number; side: "p" | "e"; key: string; star: number; r: number; c: number;
    hp: number; maxHp: number; atk: number; range: number; atkInt: number;
    mana: number; manaMax: number; cd: number; moveCd: number; stun: number; shield: number;
    buffMul: number; buffUntil: number; alive: boolean;
    spell: { type: SpellType; v: number; dur: number };
}

const cheb = (a: { r: number; c: number }, b: { r: number; c: number }) =>
    Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c));
const eu2 = (a: { r: number; c: number }, b: { r: number; c: number }) =>
    (a.r - b.r) ** 2 + (a.c - b.c) ** 2;

function makeUnits(pl: Placement[], side: "p" | "e", startId: number, mult: number): U[] {
    const traits = activeTraits(pl.map((p) => p.key));
    return pl.map((p, i) => {
        const d = UNIT_MAP[p.key];
        const si = Math.min(3, Math.max(1, p.star)) - 1;
        let hp = d.hp * C.HP_STAR[si] * mult;
        let atk = d.atk * C.ATK_STAR[si] * mult;
        let atkInt = d.atkInt;
        let mana = 0;
        for (const at of traits) {
            if (at.tier < 0) continue;
            const t = TRAIT_MAP[at.id];
            if (t.scope === "members" && d.trait !== t.id) continue;
            const v = t.values[at.tier];
            if (t.kind === "atkPct") atk *= 1 + v;
            else if (t.kind === "hpPct") hp *= 1 + v;
            else if (t.kind === "spdPct") atkInt = Math.max(3, Math.round(atkInt / (1 + v)));
            else if (t.kind === "startMana") mana += v;
        }
        hp = Math.round(hp); atk = Math.round(atk);
        const row = side === "p" ? C.BOARD_ROWS + p.r : C.BOARD_ROWS - 1 - p.r;
        return {
            id: startId + i, side, key: p.key, star: p.star, r: row, c: p.c,
            hp, maxHp: hp, atk, range: d.range, atkInt, mana: Math.min(mana, d.mana), manaMax: d.mana,
            cd: 0, moveCd: 0, stun: 0, shield: 0, buffMul: 1, buffUntil: 0, alive: true,
            spell: { type: d.spell.type, v: d.spell.v * C.SPELL_STAR[si], dur: d.spell.dur || 0 },
        };
    });
}

export function simulate(players: Placement[], enemies: Placement[], enemyMult = 1): BattleResult {
    const units: U[] = [...makeUnits(players, "p", 0, 1), ...makeUnits(enemies, "e", players.length, enemyMult)];
    const events: BattleEvent[] = [];
    const grid: number[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(-1));
    units.forEach((u) => { grid[u.r][u.c] = u.id; });
    let t = 0;

    const foes = (u: U) => units.filter((x) => x.alive && x.side !== u.side);
    const friends = (u: U) => units.filter((x) => x.alive && x.side === u.side);
    const nearest = (u: U) => {
        let best: U | null = null, bd = 1e9;
        for (const x of units) {
            if (!x.alive || x.side === u.side) continue;
            const d = cheb(u, x);
            if (d < bd) { bd = d; best = x; }
        }
        return best;
    };

    const kill = (x: U) => {
        x.alive = false; grid[x.r][x.c] = -1;
        events.push({ t, e: "d", id: x.id });
    };
    /** Trừ máu (khiên hấp thụ trước). Trả về máu còn lại. */
    const hurt = (from: U, x: U, raw: number) => {
        let dmg = Math.max(1, Math.round(raw));
        if (x.shield > 0) { const ab = Math.min(x.shield, dmg); x.shield -= ab; dmg -= ab; }
        x.hp -= dmg;
        if (x.hp > 0) x.mana = Math.min(x.manaMax, x.mana + 5);
        return Math.max(0, x.hp);
    };

    const step = (u: U, target: U) => {
        let best: { r: number; c: number } | null = null;
        let bs = eu2(u, target);
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const nr = u.r + dr, nc = u.c + dc;
            if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS || grid[nr][nc] !== -1) continue;
            const s = eu2({ r: nr, c: nc }, target);
            if (s < bs) { bs = s; best = { r: nr, c: nc }; }
        }
        if (!best) return;
        grid[u.r][u.c] = -1; u.r = best.r; u.c = best.c; grid[u.r][u.c] = u.id;
        events.push({ t, e: "m", id: u.id, r: u.r, c: u.c });
    };

    const cast = (u: U, target: U) => {
        u.mana = 0;
        const sp = u.spell;
        const dead: U[] = [];
        let tg: U[] = [], hps: number[] = [];
        if (sp.type === "aoe") {
            tg = foes(u).filter((x) => cheb(x, target) <= 1);
            tg.forEach((x) => { hps.push(hurt(u, x, sp.v)); if (x.hp <= 0) dead.push(x); });
        } else if (sp.type === "stun") {
            tg = [target]; hps = [hurt(u, target, sp.v)];
            if (target.hp <= 0) dead.push(target); else target.stun = Math.max(target.stun, sp.dur);
        } else if (sp.type === "heal") {
            const f = friends(u).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.id - b.id)[0];
            f.hp = Math.min(f.maxHp, f.hp + Math.round(sp.v));
            tg = [f]; hps = [f.hp];
        } else if (sp.type === "buff") {
            tg = friends(u);
            tg.forEach((x) => { x.buffMul = 1 + sp.v; x.buffUntil = t + sp.dur; });
        } else if (sp.type === "shield") {
            tg = friends(u).filter((x) => x === u || cheb(x, u) <= 1);
            tg.forEach((x) => { x.shield += Math.round(sp.v); });
        }
        events.push({ t, e: "s", id: u.id, sp: sp.type, tg: tg.map((x) => x.id), v: Math.round(sp.v), hp: hps });
        dead.forEach(kill);
    };

    const aliveCount = (side: "p" | "e") => units.filter((x) => x.alive && x.side === side).length;

    while (t < MAX_TICKS && aliveCount("p") > 0 && aliveCount("e") > 0) {
        t++;
        for (const u of units) {
            if (!u.alive) continue;
            if (u.stun > 0) { u.stun--; continue; }
            if (u.cd > 0) u.cd--;
            const target = nearest(u);
            if (!target) break;
            if (cheb(u, target) <= u.range) {
                if (u.cd > 0) continue;
                u.cd = u.atkInt;
                if (u.mana >= u.manaMax) { cast(u, target); continue; }
                const hp = hurt(u, target, u.atk * (t < u.buffUntil ? u.buffMul : 1));
                u.mana = Math.min(u.manaMax, u.mana + 10);
                events.push({ t, e: "a", id: u.id, tg: target.id, dmg: Math.round(u.atk), hp });
                if (target.hp <= 0) kill(target);
            } else if (u.moveCd > 0) {
                u.moveCd--;
            } else {
                u.moveCd = MOVE_TICKS - 1;
                step(u, target);
            }
        }
    }

    const left = { p: aliveCount("p"), e: aliveCount("e") };
    let winner: BattleResult["winner"];
    if (left.p > 0 && left.e === 0) winner = "p";
    else if (left.e > 0 && left.p === 0) winner = "e";
    else { // hết giờ: so tổng máu còn lại
        const sum = (s: "p" | "e") => units.filter((x) => x.alive && x.side === s).reduce((a, x) => a + x.hp, 0);
        const a = sum("p"), b = sum("e");
        winner = a > b ? "p" : b > a ? "e" : "draw";
    }
    return {
        winner, ticks: t, left, events,
        units: units.map((u) => {
            const src = players.length > u.id ? players[u.id] : enemies[u.id - players.length];
            return { id: u.id, side: u.side, key: u.key, star: u.star, maxHp: u.maxHp, r: u.side === "p" ? C.BOARD_ROWS + src.r : C.BOARD_ROWS - 1 - src.r, c: src.c };
        }),
    };
}
