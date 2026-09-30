import { Placement, BattleResult, simulate } from "./TftCombat";
import { C, UNITS, UNIT_MAP, activeTraits, hashSeed, mulberry32, sellValue } from "./TftData";

/** Trạng thái 1 lượt chơi (run) PvE. Toàn bộ là hàm thuần trên RunState, không đụng socket/DB. */
export interface Inst { uid: string; key: string; star: number }
export type Loc = { z: "bench"; i: number } | { z: "board"; i: number };   // board: i = r * 5 + c

export interface RunState {
    id: string; seed: string;
    round: number; lives: number; gold: number; level: number; xp: number;
    streak: number;                 // >0 chuỗi thắng, <0 chuỗi thua
    wins: number; rolls: number; uidSeq: number;
    shop: (string | null)[];
    bench: (Inst | null)[];
    board: (Inst | null)[];         // 15 ô: hàng 0 = tiền tuyến
    status: "shop" | "won" | "lost" | "abandoned";
}

const BOARD_SIZE = C.BOARD_COLS * C.BOARD_ROWS;

export function newRun(id: string, seed: string): RunState {
    const run: RunState = {
        id, seed, round: 1, lives: C.LIVES, gold: C.START_GOLD, level: C.START_LEVEL, xp: 0, streak: 0,
        wins: 0, rolls: 0, uidSeq: 0, shop: [], bench: Array(C.BENCH).fill(null), board: Array(BOARD_SIZE).fill(null),
        status: "shop",
    };
    rollShop(run);
    return run;
}

// ---------- cửa hàng ----------
export function rollShop(run: RunState) {
    const rng = mulberry32(hashSeed(`${run.seed}:shop:${run.round}:${run.rolls}`));
    run.rolls++;
    const odds = C.SHOP_ODDS[run.level];
    run.shop = Array.from({ length: C.SHOP_SIZE }, () => {
        let x = rng() * 100, cost = 1;
        for (let i = 0; i < odds.length; i++) { x -= odds[i]; if (x < 0) { cost = i + 1; break; } }
        const pool = UNITS.filter((u) => u.cost === cost);
        return pool[Math.floor(rng() * pool.length)].key;
    });
}

// ---------- tiện ích vị trí ----------
const all = (run: RunState) => [...run.board, ...run.bench].filter(Boolean) as Inst[];
const boardCount = (run: RunState) => run.board.filter(Boolean).length;
const arr = (run: RunState, z: Loc["z"]) => (z === "bench" ? run.bench : run.board);

function assertActive(run: RunState) {
    if (run.status !== "shop") throw new Error("Lượt chơi đã kết thúc");
}

/** Gộp 3 quân giống nhau (cùng sao) thành 1 quân sao cao hơn; lặp tới khi hết. Ưu tiên giữ quân đang ở sân. */
function mergeAll(run: RunState) {
    for (let again = true; again;) {
        again = false;
        const groups = new Map<string, { z: Loc["z"]; i: number }[]>();
        const scan = (z: Loc["z"]) => arr(run, z).forEach((u, i) => {
            if (u && u.star < 3) { const k = `${u.key}:${u.star}`; (groups.get(k) || groups.set(k, []).get(k)!).push({ z, i }); }
        });
        scan("board"); scan("bench"); // board quét trước nên đứng đầu nhóm
        for (const locs of groups.values()) {
            if (locs.length < 3) continue;
            const [keep, ...rest] = locs;
            arr(run, keep.z)[keep.i]!.star++;
            rest.slice(0, 2).forEach((l) => { arr(run, l.z)[l.i] = null; });
            again = true; break;
        }
    }
}

/** Đặt quân mới vào hàng chờ; hết chỗ thì chỉ cho phép nếu mua xong sẽ gộp được. */
function addUnit(run: RunState, key: string): boolean {
    const inst: Inst = { uid: `u${++run.uidSeq}`, key, star: 1 };
    const free = run.bench.findIndex((x) => !x);
    if (free >= 0) { run.bench[free] = inst; mergeAll(run); return true; }
    const same = all(run).filter((u) => u.key === key && u.star === 1);
    if (same.length < 2) { run.uidSeq--; return false; }
    same[0].star++;
    const drop = same[1];
    [run.board, run.bench].forEach((a) => { const i = a.indexOf(drop); if (i >= 0) a[i] = null; });
    mergeAll(run);
    return true;
}

// ---------- hành động ----------
export function buy(run: RunState, slot: number) {
    assertActive(run);
    const key = run.shop[slot];
    if (!key) throw new Error("Ô này đã trống");
    const cost = UNIT_MAP[key].cost;
    if (run.gold < cost) throw new Error("Không đủ vàng");
    if (!addUnit(run, key)) throw new Error("Hàng chờ đã đầy");
    run.gold -= cost;
    run.shop[slot] = null;
}

export function sell(run: RunState, loc: Loc) {
    assertActive(run);
    const a = arr(run, loc.z);
    const u = a[loc.i];
    if (!u) throw new Error("Không có quân ở ô này");
    run.gold += sellValue(u.key, u.star);
    a[loc.i] = null;
}

const validLoc = (l: Loc) => l && (l.z === "bench" || l.z === "board")
    && Number.isInteger(l.i) && l.i >= 0 && l.i < (l.z === "bench" ? C.BENCH : BOARD_SIZE);

/** Hoán đổi/di chuyển giữa 2 ô bất kỳ (hàng chờ <-> sân). Sân không được vượt quá cấp hiện tại. */
export function move(run: RunState, from: Loc, to: Loc) {
    assertActive(run);
    if (!validLoc(from) || !validLoc(to)) throw new Error("Vị trí không hợp lệ");
    const fa = arr(run, from.z), ta = arr(run, to.z);
    if (!fa[from.i]) throw new Error("Không có quân ở ô này");
    const moving = fa[from.i];
    const other = ta[to.i];
    fa[from.i] = other; ta[to.i] = moving;
    if (boardCount(run) > run.level) { // hoàn tác
        fa[from.i] = moving; ta[to.i] = other;
        throw new Error(`Sân chỉ chứa tối đa ${run.level} quân (nâng cấp để thêm)`);
    }
}

export function reroll(run: RunState) {
    assertActive(run);
    if (run.gold < C.REROLL_COST) throw new Error("Không đủ vàng");
    run.gold -= C.REROLL_COST;
    rollShop(run);
}

function gainXp(run: RunState, n: number) {
    run.xp += n;
    while (run.level < C.MAX_LEVEL && run.xp >= C.XP_NEED[run.level]) { run.xp -= C.XP_NEED[run.level]; run.level++; }
    if (run.level >= C.MAX_LEVEL) run.xp = 0;
}

export function buyXp(run: RunState) {
    assertActive(run);
    if (run.level >= C.MAX_LEVEL) throw new Error("Đã đạt cấp tối đa");
    if (run.gold < C.XP_COST) throw new Error("Không đủ vàng");
    run.gold -= C.XP_COST;
    gainXp(run, C.XP_PER_BUY);
}

// ---------- đối thủ PvE ----------
const ENEMY_NAMES = [
    "Email dồn cuối tuần", "Khách đổi ý lúc 5 giờ chiều", "Deadline nhích lại gần", "Bug chỉ xuất hiện trên production",
    "Cuộc họp không có agenda", "Revision lần thứ 9", "Khách muốn “làm lại hết”", "Server sập đúng lúc demo",
    "Đợt kiểm toán bất ngờ", "Tăng ca xuyên đêm", "Chốt sổ cuối quý", "BOSS: Tuần lễ Deadline",
];
const COUNTS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 6, 7, 7];
const MAXC = [1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5];
const STAR2 = [0, 0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 4];
const MULT = [0.8, 0.85, 0.9, 0.95, 1, 1, 1.05, 1.05, 1.05, 1.05, 1.1, 1.1];
const COL_ORDER = [2, 1, 3, 0, 4];

export interface Enemy { name: string; placements: Placement[]; mult: number }

export function enemyName(round: number) { return ENEMY_NAMES[Math.min(round, C.TOTAL_ROUNDS) - 1]; }

export function genEnemy(seed: string, round: number): Enemy {
    const i = Math.min(round, C.TOTAL_ROUNDS) - 1;
    const rng = mulberry32(hashSeed(`${seed}:enemy:${round}`));
    const keys: string[] = [];
    const boss = round >= C.TOTAL_ROUNDS;
    if (boss) keys.push("ceo");
    while (keys.length < COUNTS[i]) {
        // nghiêng về bậc cao nhất cho phép
        let cost = rng() < 0.6 ? MAXC[i] : Math.max(1, MAXC[i] - 1);
        let pool = UNITS.filter((u) => u.cost === cost && !(boss && u.key === "ceo"));
        while (!pool.length && cost > 1) { cost--; pool = UNITS.filter((u) => u.cost === cost); } // vd: bậc 5 chỉ có CEO
        keys.push(pool[Math.floor(rng() * pool.length)].key);
    }
    const stars = keys.map((k, n) => (boss && n === 0 ? 2 : 1));
    // nâng sao cho các quân đắt nhất trước
    const order = keys.map((k, n) => n).sort((a, b) => UNIT_MAP[keys[b]].cost - UNIT_MAP[keys[a]].cost || a - b);
    let up = STAR2[i];
    for (const n of order) { if (up <= 0) break; if (stars[n] === 1) { stars[n] = 2; up--; } }
    // xếp hàng: đánh gần đứng trước, đánh xa đứng sau
    const rowUsed = [0, 0, 0];
    const placements: Placement[] = keys.map((key, n) => {
        const range = UNIT_MAP[key].range;
        let r = range <= 1 ? 0 : range === 2 ? 1 : 2;
        while (rowUsed[r] >= C.BOARD_COLS) r = (r + 1) % 3;
        return { key, star: stars[n], r, c: COL_ORDER[rowUsed[r]++] };
    });
    return { name: ENEMY_NAMES[i], placements, mult: MULT[i] };
}

// ---------- chiến đấu ----------
export interface FightOutcome {
    battle: BattleResult & { enemyName: string; round: number };
    win: boolean;
    income: { base: number; interest: number; streak: number; total: number } | null;
    finished: boolean;
}

export function boardPlacements(run: RunState): Placement[] {
    const out: Placement[] = [];
    run.board.forEach((u, i) => { if (u) out.push({ key: u.key, star: u.star, r: Math.floor(i / C.BOARD_COLS), c: i % C.BOARD_COLS }); });
    return out;
}

export function fight(run: RunState): FightOutcome {
    assertActive(run);
    const mine = boardPlacements(run);
    if (!mine.length) throw new Error("Hãy đặt ít nhất 1 quân lên sân");
    const enemy = genEnemy(run.seed, run.round);
    const res = simulate(mine, enemy.placements, enemy.mult);
    const win = res.winner === "p";
    const round = run.round;

    if (win) { run.wins++; run.streak = run.streak > 0 ? run.streak + 1 : 1; }
    else { run.lives--; run.streak = run.streak < 0 ? run.streak - 1 : -1; }

    let income: FightOutcome["income"] = null;
    let finished = false;
    if (win && round >= C.TOTAL_ROUNDS) { run.status = "won"; finished = true; }
    else if (run.lives <= 0) { run.status = "lost"; finished = true; }
    else {
        run.round++;
        const base = C.BASE_INCOME;
        const interest = Math.min(5, Math.floor(run.gold / 10));
        const s = Math.abs(run.streak);
        const streak = s >= 6 ? 3 : s >= 4 ? 2 : s >= 2 ? 1 : 0;
        income = { base, interest, streak, total: base + interest + streak };
        run.gold += income.total;
        gainXp(run, C.XP_PER_ROUND);
        run.rolls = 0;
        rollShop(run);
    }
    return { battle: { ...res, enemyName: enemy.name, round }, win, income, finished };
}

// ---------- dữ liệu gửi cho client ----------
export function view(run: RunState) {
    const boardKeys = run.board.filter(Boolean).map((u) => u!.key);
    const next = Math.min(run.round, C.TOTAL_ROUNDS);
    const enemy = genEnemy(run.seed, next);
    return {
        id: run.id, status: run.status, round: run.round, totalRounds: C.TOTAL_ROUNDS, lives: run.lives,
        gold: run.gold, level: run.level, xp: run.xp, xpNeed: run.level >= C.MAX_LEVEL ? 0 : C.XP_NEED[run.level],
        streak: run.streak, wins: run.wins,
        shop: run.shop, bench: run.bench, board: run.board,
        traits: activeTraits(boardKeys),
        interest: Math.min(5, Math.floor(run.gold / 10)),
        // xem trước đối thủ vòng này: tên + đội hình (PvE nên không có gì phải giấu)
        enemy: { name: enemy.name, units: enemy.placements.map((p) => ({ key: p.key, star: p.star })) },
    };
}
