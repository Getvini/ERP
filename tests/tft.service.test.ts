import test from "node:test";
import assert from "node:assert/strict";
import { AppDataSource } from "../src/data-source";
import { TftService } from "../src/modules/tft/services/Tft.Service";
import { TftPlayers } from "../src/modules/tft/entities/TftPlayer.entity";
import { TftRuns } from "../src/modules/tft/entities/TftRun.entity";

/** DB giả trong RAM: đủ cho findOne/save/create mà service dùng. */
function fakeRepo(store: any[]) {
    const match = (row: any, where: any) => Object.entries(where).every(([k, v]) => row[k] === v);
    return {
        create: (x: any) => ({ ...x }),
        findOne: async ({ where }: any) => [...store].reverse().find((r) => match(r, where)) || null,
        findOneOrFail: async ({ where }: any) => store.find((r) => match(r, where)),
        save: async (x: any) => {
            if (!x.id) x.id = `id${store.length}`;          // TypeORM thật cũng trả entity đã có id (BeforeInsert)
            const i = store.findIndex((r) => r.id === x.id);
            if (i >= 0) store[i] = { ...store[i], ...x }; else store.push({ createdAt: new Date(), ...x });
            return x;
        },
    };
}

function harness() {
    (TftService as any).live.clear();       // service là singleton: reset để các test không ảnh hưởng nhau
    (TftService as any).buckets.clear();
    const runs: any[] = [], players: any[] = [];
    (AppDataSource as any).getRepository = (e: any) => fakeRepo(e === TftRuns ? runs : players);
    const handlers: Record<string, Function> = {};
    const socket: any = { user: { accountId: "acc1" }, join() {}, on: (ev: string, fn: Function) => { handlers[ev] = fn; } };
    TftService.attach(socket);
    const call = (ev: string, data?: any) => new Promise<any>((res) => handlers[ev](data, res));
    return { runs, players, call };
}

test("luồng đầy đủ: start -> mua -> xếp -> đánh, ack đúng hình dạng", async () => {
    const { call, runs } = harness();
    const s = await call("tft:sync");
    assert.equal(s.ok, true);
    assert.ok(s.catalog.units.length >= 12 && s.catalog.traits.length >= 4);
    assert.equal(s.state, null);

    const st = await call("tft:start");
    assert.equal(st.ok, true);
    assert.equal(st.state.round, 1);
    assert.equal(st.state.shop.length, 5);
    assert.equal((st.state as any).seed, undefined);
    assert.equal(runs.length, 1);

    // mua quân rẻ nhất mua được, đặt lên sân
    const slot = st.state.shop.findIndex((k: string | null) => k);
    const b = await call("tft:buy", { slot });
    assert.equal(b.ok, true);
    assert.ok(b.state.gold < st.state.gold);
    const bi = b.state.bench.findIndex(Boolean);
    const mv = await call("tft:move", { from: { z: "bench", i: bi }, to: { z: "board", i: 0 } });
    assert.equal(mv.ok, true);
    assert.ok(mv.state.board[0]);

    const f = await call("tft:fight");
    assert.equal(f.ok, true);
    assert.ok(f.battle.events.length > 0 && f.battle.units.length >= 3);
    assert.equal(f.battle.round, 1);
    assert.ok(["p", "e", "draw"].includes(f.battle.winner));
    assert.equal(typeof f.win, "boolean");
    if (!f.finished) { assert.equal(f.state.round, 2); assert.ok(f.income.total >= 5); }
    // DB được ghi đầu vòng mới
    assert.equal(runs[0].round, f.state.round);
});

test("thao tác sai trả lỗi có thông điệp, không ném ra ngoài", async () => {
    const { call } = harness();
    let r = await call("tft:buy", { slot: 0 });
    assert.deepEqual([r.ok, r.error], [false, "Chưa có lượt chơi nào"]);
    await call("tft:start");
    r = await call("tft:fight");                 // sân rỗng
    assert.equal(r.ok, false); assert.match(r.error, /ít nhất 1 quân/);
    r = await call("tft:move", { from: { z: "bench", i: 99 }, to: { z: "board", i: 0 } });
    assert.equal(r.ok, false);
    r = await call("tft:sell", { at: { z: "hack", i: 0 } });
    assert.equal(r.ok, false);
});

test("start lần 2 tiếp tục lượt đang chơi, không tạo lượt mới", async () => {
    const { call, runs } = harness();
    const a = await call("tft:start");
    const b = await call("tft:start");
    assert.equal(b.resumed, true);
    assert.equal(b.state.id, a.state.id);
    assert.equal(runs.length, 1);
});

test("khôi phục từ DB khi RAM bị giải phóng (restart/idle)", async () => {
    const { call } = harness();
    const a = await call("tft:start");
    await (TftService as any).sweep();           // chưa idle => vẫn còn
    assert.equal(TftService.counts().live, 1);
    (TftService as any).live.clear();            // giả lập restart server
    const s = await call("tft:sync");
    assert.equal(s.state.id, a.state.id);
    assert.deepEqual(s.state.shop, a.state.shop);
});

test("bỏ lượt chơi ghi thống kê, rồi bắt đầu được lượt mới", async () => {
    const { call, players } = harness();
    const a = await call("tft:start");
    assert.equal((await call("tft:abandon")).ok, true);
    assert.equal(players.length, 1);
    assert.equal(players[0].runs, 1);
    const b = await call("tft:start");
    assert.notEqual(b.state.id, a.state.id);
});

test("chống spam: quá nhiều thao tác liên tiếp bị từ chối", async () => {
    const { call } = harness();
    await call("tft:start");
    const results = await Promise.all(Array.from({ length: 60 }, () => call("tft:sync")));
    const blocked = results.filter((r) => !r.ok).length;
    assert.ok(blocked > 0 && blocked < 60, `blocked=${blocked}`);
    assert.match(results.find((r) => !r.ok)!.error, /quá nhanh/);
});
