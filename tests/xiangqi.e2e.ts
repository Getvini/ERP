/**
 * Kiểm thử tích hợp cờ tướng: PostgreSQL thật + socket.io thật + JWT thật.
 * Chạy: DB_HOST=... DB_PORT=... DB_USER=... DB_NAME=... JWT_SECRET=... npx ts-node tests/xiangqi.e2e.ts
 */
import "reflect-metadata";
import "dotenv/config";
import { createServer } from "http";
import jwt from "jsonwebtoken";
import { io as connect, Socket } from "socket.io-client";
import { AppDataSource } from "../src/data-source";
import { initSocket } from "../src/socket";
import { Accounts } from "../src/modules/account/entities/Account.entity";
import { Users } from "../src/modules/user/entities/User.entity";
import { XiangqiPlayers } from "../src/modules/xiangqi/entities/XiangqiPlayer.entity";
import { XiangqiGames } from "../src/modules/xiangqi/entities/XiangqiGame.entity";
import { XiangqiService } from "../src/modules/xiangqi/services/Xiangqi.Service";

let pass = 0;
const ok = (cond: any, msg: string) => {
    if (!cond) { console.error("  ✗ FAIL:", msg); process.exitCode = 1; throw new Error(msg); }
    pass++; console.log("  ✓", msg);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const firstState = async (s: Socket, ms = 5000) => {
    const t0 = Date.now();
    while (!(s as any).buf.length) { if (Date.now() - t0 > ms) throw new Error("timeout waiting state"); await sleep(50); }
    return (s as any).buf[(s as any).buf.length - 1];
};
const once = <T = any>(s: Socket, ev: string, ms = 8000) => new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout waiting " + ev)), ms);
    s.once(ev, (d: T) => { clearTimeout(t); res(d); });
});
const emit = (s: Socket, ev: string, data?: any) => new Promise<any>((res) => s.emit(ev, data, res));

async function makeAccount(name: string) {
    const ur = AppDataSource.getRepository(Users), ar = AppDataSource.getRepository(Accounts);
    const u = await ur.save(ur.create({ fullName: "Tester " + name, phoneNumber: "0" }));
    const a = await ar.save(ar.create({ username: name + Date.now(), password: "x", role: "STAFF_A" as any, isActive: true, userId: u.id }));
    const token = jwt.sign({ id: a.id, type: "access" }, process.env.JWT_SECRET || "");
    return { id: a.id, token };
}

async function main() {
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
    await AppDataSource.initialize();
    const server = createServer();
    initSocket(server);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    const url = `http://localhost:${port}`;
    const open = (token: string) => {
        const s = connect(url, { auth: { token }, transports: ["websocket"], reconnection: false });
        const buf: any[] = []; // gom sự kiện server gửi ngay lúc kết nối, trước khi test kịp lắng nghe
        s.on("xq:game:state", (d: any) => buf.push(d));
        (s as any).buf = buf;
        return new Promise<Socket>((res, rej) => { s.on("connect", () => res(s)); s.on("connect_error", rej); });
    };

    const [A, B, C, D] = await Promise.all(["a", "b", "c", "d"].map(makeAccount));

    console.log("\n[1] Xác thực socket");
    await open("token-rac").then(() => ok(false, "token rác phải bị từ chối"), () => ok(true, "token rác bị từ chối"));
    const sa = await open(A.token);
    const sb = await open(B.token);
    ok(sa.connected && sb.connected, "hai tài khoản A, B kết nối thành công bằng JWT");

    console.log("\n[2] Ghép trận A <-> B");
    const foundA = once(sa, "xq:match:found"), foundB = once(sb, "xq:match:found");
    const stateA = once(sa, "xq:game:state");
    ok((await emit(sa, "xq:queue:join", { tc: 999 })).ok === false, "mốc thời gian không hợp lệ bị từ chối");
    ok((await emit(sa, "xq:queue:join", { tc: 180 })).ok, "A vào hàng đợi");
    ok((await emit(sb, "xq:queue:join", { tc: 180 })).ok, "B vào hàng đợi");
    const [fa, fb] = await Promise.all([foundA, foundB]);
    ok(fa.gameId === fb.gameId, "cả hai nhận cùng gameId");
    const st = await stateA;
    ok(st.red.accountId !== st.black.accountId, "hai bên là hai tài khoản khác nhau");
    ok([st.red.accountId, st.black.accountId].sort().join() === [A.id, B.id].sort().join(), "đúng cặp A và B");
    const gameId = st.gameId;
    const red = st.red.accountId === A.id ? sa : sb;
    const black = red === sa ? sb : sa;
    ok((await emit(sa, "xq:queue:join", { tc: 180 })).ok === false, "đang trong ván thì không vào hàng đợi được");

    console.log("\n[3] Nước đi do server kiểm tra");
    ok((await emit(black, "xq:move", { gameId, move: { fr: 0, fc: 0, tr: 1, tc: 0 } })).ok === false, "sai lượt bị từ chối");
    ok((await emit(red, "xq:move", { gameId, move: { fr: 9, fc: 0, tr: 5, tc: 0 } })).ok === false, "xe đi xuyên quân bị từ chối");
    ok((await emit(red, "xq:move", { gameId, move: { fr: 6, fc: 0, tr: 4, tc: 0 } })).ok === false, "tốt đi 2 ô bị từ chối");
    const mvOnBlack = once(black, "xq:game:move");
    ok((await emit(red, "xq:move", { gameId, move: { fr: 7, fc: 7, tr: 7, tc: 4 } })).ok, "pháo đầu hợp lệ");
    const mv = await mvOnBlack;
    ok(mv.turn === "b" && mv.ply === 1, "đối thủ nhận nước đi realtime, tới lượt Đen");
    const mvOnRed = once(red, "xq:game:move");
    ok((await emit(black, "xq:move", { gameId, move: { fr: 0, fc: 7, tr: 2, tc: 6 } })).ok, "Đen đáp mã hợp lệ");
    await mvOnRed;
    const outsider = await open(C.token);
    ok((await emit(outsider, "xq:move", { gameId, move: { fr: 6, fc: 0, tr: 5, tc: 0 } })).ok === false, "người ngoài ván không đi được");

    console.log("\n[4] Nhiều thiết bị + kết nối lại");
    const sa2 = await open(A.token);
    const st2 = await firstState(sa2);
    ok(st2.gameId === gameId && st2.moves.length === 2, "thiết bị thứ 2 của A nhận đúng trạng thái ván");
    sa2.disconnect();
    black.disconnect();
    await sleep(300);
    const black2 = await open(red === sa ? B.token : A.token);
    const st3 = await firstState(black2);
    ok(st3.gameId === gameId && st3.moves.length === 2 && st3.turn === "r", "rớt mạng rồi kết nối lại vẫn vào lại ván, còn nguyên thế cờ");

    console.log("\n[5] Xin hòa");
    const offered = once(black2, "xq:draw:offered");
    ok((await emit(red, "xq:draw:offer", { gameId })).ok, "Đỏ xin hòa");
    await offered;
    ok((await emit(red, "xq:draw:respond", { gameId, accept: true })).ok === false, "bên xin hòa không tự chấp nhận được");
    const over = once<any>(red, "xq:game:over");
    ok((await emit(black2, "xq:draw:respond", { gameId, accept: true })).ok, "đối thủ chấp nhận hòa");
    const o = await over;
    ok(o.result === "draw" && o.reason === "agreement", "ván kết thúc hòa theo thỏa thuận");
    ok(o.ratings.red.after === o.ratings.red.before, "hòa giữa 2 người cùng rating: rating không đổi");
    const liveA = red === sa ? sa : black2; // socket còn sống của A và B sau bước kết nối lại
    const liveB = red === sa ? black2 : sb;

    console.log("\n[6] Ván 2: chấp nhận thua, cập nhật Elo và lưu DB");
    const f2 = Promise.all([once(liveA, "xq:match:found"), once(liveB, "xq:match:found")]);
    await emit(liveA, "xq:queue:join", { tc: 300 }); await emit(liveB, "xq:queue:join", { tc: 300 });
    await f2;
    const g2 = XiangqiService.activeGameOf(A.id)!;
    const redSock = g2.red.accountId === A.id ? liveA : liveB;
    const blackSock = redSock === liveA ? liveB : liveA;
    await emit(redSock, "xq:move", { gameId: g2.gameId, move: { fr: 7, fc: 7, tr: 7, tc: 4 } });
    await emit(blackSock, "xq:move", { gameId: g2.gameId, move: { fr: 0, fc: 7, tr: 2, tc: 6 } });
    const over2 = once<any>(redSock, "xq:game:over");
    ok((await emit(blackSock, "xq:resign", { gameId: g2.gameId })).ok, "Đen xin thua");
    const o2 = await over2;
    ok(o2.result === "red" && o2.reason === "resign", "Đỏ thắng do đối thủ xin thua");
    ok(o2.ratings.red.after > 1200 && o2.ratings.black.after < 1200, `Elo: thắng tăng (${o2.ratings.red.after}), thua giảm (${o2.ratings.black.after})`);
    ok(o2.ratings.red.after - 1200 === 1200 - o2.ratings.black.after, "tổng điểm Elo được bảo toàn (cùng hệ số K)");
    const row = await AppDataSource.getRepository(XiangqiGames).findOneByOrFail({ id: g2.gameId });
    ok(row.status === "finished" && row.result === "red" && (row.moves || []).length === 2, "ván được lưu DB kèm danh sách nước đi");
    const pl = await AppDataSource.getRepository(XiangqiPlayers).findOneByOrFail({ accountId: g2.red.accountId });
    ok(pl.wins === 1 && pl.gamesPlayed === 2, "thống kê người chơi được cập nhật");

    console.log("\n[7] Huỷ hàng đợi & không ghép người lệch rating");
    await XiangqiService.getPlayer(D.id);
    await AppDataSource.getRepository(XiangqiPlayers).update({ accountId: D.id }, { rating: 1500 });
    const sc = outsider, sd = await open(D.token);
    await emit(sc, "xq:queue:join", { tc: 180 }); await emit(sd, "xq:queue:join", { tc: 180 });
    await sleep(2500);
    ok(XiangqiService.activeGameOf(C.id) === null, "C (1200) và D (1500) chưa bị ghép khi cửa sổ rating còn hẹp");
    const st7 = await once<any>(sc, "xq:queue:status");
    ok(st7.queued && st7.ratingWindow > 100, "cửa sổ rating giãn ra theo thời gian chờ (" + st7.ratingWindow + ")");
    const found7 = await once(sc, "xq:match:found", 9000);
    ok(!!found7, "sau khi cửa sổ giãn đủ rộng, C và D được ghép với nhau");
    ok(XiangqiService.activeGameOf(D.id) !== null, "D cũng thấy ván mới");

    console.log("\n[8] Rời hàng đợi");
    const sb2 = await open(B.token);
    await emit(sb2, "xq:queue:join", { tc: 600 });
    const lv = await emit(sb2, "xq:queue:leave");
    ok(lv.ok && lv.wasQueued, "rời hàng đợi thành công");
    ok(XiangqiService.counts().queued === 0, "hàng đợi trống");

    console.log(`\nTất cả ${pass} kiểm tra đạt.`);
    XiangqiService.stop();
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
