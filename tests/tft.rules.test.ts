import test from "node:test";
import assert from "node:assert/strict";
import { simulate } from "../src/modules/tft/rules/TftCombat";
import { C, UNIT_MAP, UNITS, activeTraits } from "../src/modules/tft/rules/TftData";
import { RunState, buy, buyXp, fight, genEnemy, move, newRun, reroll, sell, view } from "../src/modules/tft/rules/TftRun";

const place = (key: string, star = 1, r = 0, c = 2) => ({ key, star, r, c });

test("mô phỏng xác định: cùng đầu vào => cùng log", () => {
    const a = [place("sr", 1, 0, 1), place("ts", 1, 2, 2)];
    const b = [place("ed", 1, 0, 2), place("rv", 1, 2, 3)];
    const x = simulate(a, b, 1), y = simulate(a, b, 1);
    assert.deepEqual(x, y);
    assert.ok(x.ticks > 0 && x.ticks <= 400);
});

test("quân mạnh hơn (sao cao) thắng quân yếu", () => {
    assert.equal(simulate([place("ed", 3)], [place("ed", 1)]).winner, "p");
    assert.equal(simulate([place("ed", 1)], [place("ed", 3)]).winner, "e");
});

test("trận đấu luôn kết thúc, độ lớn log hợp lý", () => {
    const team = (n: number) => UNITS.slice(0, n).map((u, i) => place(u.key, 1, i % 3, i % 5));
    const r = simulate(team(7), team(7).map((p, i) => ({ ...p, c: (p.c + 1) % 5, r: (i + 1) % 3 })));
    assert.ok(r.ticks <= 400);
    assert.ok(JSON.stringify(r.events).length < 60_000, "log quá lớn");
});

test("trait đếm quân khác nhau", () => {
    assert.deepEqual(activeTraits(["ed", "ed", "ed"]).find((t) => t.id === "production"), { id: "production", count: 1, tier: -1 });
    assert.equal(activeTraits(["ed", "dg"]).find((t) => t.id === "production")!.tier, 0);
});

test("mua, gộp 3 thành sao 2, bán, hoàn vàng", () => {
    const run = newRun("r", "seed-merge");
    run.gold = 100;
    for (let n = 0; n < 3; n++) { run.shop[0] = "ed"; buy(run, 0); }
    const units = [...run.bench, ...run.board].filter(Boolean);
    assert.equal(units.length, 1);
    assert.equal(units[0]!.star, 2);
    assert.equal(run.gold, 97);
    const g = run.gold;
    sell(run, { z: "bench", i: run.bench.findIndex(Boolean) });
    assert.equal(run.gold, g + 2); // 1*3-1
});

test("hàng chờ đầy thì không mua được trừ khi gộp được", () => {
    const run = newRun("r", "seed-full");
    run.gold = 999;
    const others = UNITS.filter((u) => u.key !== "ed").slice(0, C.BENCH);
    others.forEach((u, i) => { run.bench[i] = { uid: `x${i}`, key: u.key, star: 1 }; });
    run.shop[0] = "ed";
    assert.throws(() => buy(run, 0), /đầy/);
    assert.equal(run.gold, 999);
    run.bench[0] = { uid: "a", key: "ed", star: 1 }; run.bench[1] = { uid: "b", key: "ed", star: 1 };
    run.shop[0] = "ed";
    buy(run, 0);
    assert.equal([...run.bench].filter((u) => u?.key === "ed" && u.star === 2).length, 1);
});

test("sân không vượt quá cấp, hoàn tác khi vượt", () => {
    const run = newRun("r", "seed-cap");
    for (let i = 0; i < 4; i++) run.bench[i] = { uid: `b${i}`, key: UNITS[i].key, star: 1 };
    for (let i = 0; i < C.START_LEVEL; i++) move(run, { z: "bench", i }, { z: "board", i });
    assert.throws(() => move(run, { z: "bench", i: 3 }, { z: "board", i: 7 }), /tối đa/);
    assert.ok(run.bench[3], "quân phải còn ở hàng chờ");
    assert.equal(run.board.filter(Boolean).length, C.START_LEVEL);
    // hoán đổi quân khi sân đã đầy vẫn hợp lệ
    move(run, { z: "bench", i: 3 }, { z: "board", i: 0 });
    assert.equal(run.board.filter(Boolean).length, C.START_LEVEL);
});

test("reroll/mua kinh nghiệm trừ vàng, không cho âm", () => {
    const run = newRun("r", "seed-eco");
    run.gold = 5;
    reroll(run); assert.equal(run.gold, 3);
    assert.throws(() => buyXp(run), /vàng/); // còn 3 < 4 vàng
    assert.equal(run.gold, 3);
    run.gold = 10; buyXp(run); assert.equal(run.gold, 6); assert.equal(run.xp, 4);
    buyXp(run); assert.equal(run.level, C.START_LEVEL + 1); // 8 xp >= 6 => lên cấp, dư 2
});

test("shop xác định theo seed", () => {
    assert.deepEqual(newRun("a", "same").shop, newRun("b", "same").shop);
    assert.notDeepEqual(newRun("a", "s1").shop, newRun("a", "s2").shop);
});

test("đối thủ: vòng cuối có CEO, đội hình hợp lệ, không trùng ô", () => {
    for (let r = 1; r <= C.TOTAL_ROUNDS; r++) {
        const e = genEnemy("x", r);
        const cells = new Set(e.placements.map((p) => `${p.r},${p.c}`));
        assert.equal(cells.size, e.placements.length);
        e.placements.forEach((p) => { assert.ok(UNIT_MAP[p.key]); assert.ok(p.r >= 0 && p.r < 3 && p.c >= 0 && p.c < 5); });
    }
    assert.ok(genEnemy("x", C.TOTAL_ROUNDS).placements.some((p) => p.key === "ceo"));
});

// ---------- bot tham lam để canh độ khó (không dùng trong production) ----------
function botPlay(seed: string, skill: "low" | "mid") {
    const run = newRun("bot", seed);
    const power = (u: { key: string; star: number }) => UNIT_MAP[u.key].cost * 10 ** (u.star - 1) + UNIT_MAP[u.key].hp / 1000;
    while (run.status === "shop") {
        // 0) bot "mid" lên cấp theo mốc vòng như người chơi bình thường (vòng 2->cấp 4, 4->5, 6->6, 8->7)
        if (skill === "mid") {
            const target = Math.min(C.MAX_LEVEL, 3 + Math.floor(run.round / 2));
            while (run.level < target && run.gold >= C.XP_COST) buyXp(run);
        }
        // 1) mua: ưu tiên quân đã có (để gộp), sau đó quân đắt nhất mua được
        for (let pass = 0; pass < 6; pass++) {
            const owned = new Set([...run.bench, ...run.board].filter(Boolean).map((u) => u!.key));
            const want = run.shop.map((k, i) => ({ k, i })).filter((x) => x.k && UNIT_MAP[x.k].cost <= run.gold)
                .sort((a, b) => (+owned.has(b.k!) - +owned.has(a.k!)) || UNIT_MAP[b.k!].cost - UNIT_MAP[a.k!].cost)[0];
            if (!want) break;
            // giữ lãi khi đã khá giàu ở đầu game
            if (skill === "mid" && run.round <= 4 && run.gold - UNIT_MAP[want.k!].cost < 10 && run.gold >= 10 && !owned.has(want.k!)) break;
            try { buy(run, want.i); } catch { break; }
        }
        // 2) lên cấp khi dư vàng
        while (skill === "mid" && run.level < C.MAX_LEVEL && run.gold >= 12) buyXp(run);
        if (skill === "mid" && run.gold >= 10 && run.round >= 3) { try { reroll(run); buy(run, run.shop.findIndex((k) => k && UNIT_MAP[k].cost <= run.gold)); } catch { /* bỏ qua */ } }
        // 3) xếp đội: lấy quân mạnh nhất, cận chiến lên trước
        const pool = [...run.board, ...run.bench].filter(Boolean) as { uid: string; key: string; star: number }[];
        run.board.fill(null); run.bench.fill(null);
        pool.sort((a, b) => power(b) - power(a));
        const chosen = pool.slice(0, run.level), rest = pool.slice(run.level);
        rest.slice(0, C.BENCH).forEach((u, i) => { run.bench[i] = u; });
        const rows = [0, 0, 0];
        chosen.forEach((u) => {
            const rg = UNIT_MAP[u.key].range; let r = rg <= 1 ? 0 : rg === 2 ? 1 : 2;
            while (rows[r] >= 5) r = (r + 1) % 3;
            run.board[r * 5 + [2, 1, 3, 0, 4][rows[r]++]] = u;
        });
        fight(run);
    }
    return { round: run.round, status: run.status };
}

test("cân bằng: bot tham lam — phân bố vòng đạt được", () => {
    for (const skill of ["low", "mid"] as const) {
        const rounds: number[] = []; let won = 0; const N = 300;
        for (let i = 0; i < N; i++) { const r = botPlay(`bal-${skill}-${i}`, skill); rounds.push(r.round); if (r.status === "won") won++; }
        rounds.sort((a, b) => a - b);
        const med = rounds[N >> 1], p10 = rounds[Math.floor(N * 0.1)], p90 = rounds[Math.floor(N * 0.9)];
        console.log(`[balance:${skill}] trung vị vòng=${med} p10=${p10} p90=${p90} thắng cả run=${((won / N) * 100).toFixed(0)}%`);
        assert.ok(med >= 3, "quá khó ngay từ đầu");
    }
});

test("fight không đổi khi board rỗng => báo lỗi", () => {
    const run = newRun("r", "empty");
    assert.throws(() => fight(run), /ít nhất 1 quân/);
});

test("view không lộ trạng thái thừa và có xem trước đối thủ", () => {
    const v = view(newRun("r", "v"));
    assert.ok(v.enemy.units.length >= 2);
    assert.equal(v.shop.length, C.SHOP_SIZE);
    assert.equal((v as any).seed, undefined);
});
