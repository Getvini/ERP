import { Server } from "socket.io";
import { ulid } from "ulid";
import { AppDataSource } from "../../../data-source";
import { Accounts } from "../../account/entities/Account.entity";
import { XiangqiPlayers } from "../entities/XiangqiPlayer.entity";
import { XiangqiGames } from "../entities/XiangqiGame.entity";
import {
    Board, Color, Move, applyMove, initialBoard, insufficientMaterial, isInCheck, isLegalMove,
    other, outcomeAfterMove, positionKey, repetitionResult,
} from "../rules/XiangqiRules";

export const TIME_CONTROLS = [180, 300, 600]; // giây cho mỗi bên
const FIRST_MOVE_TIMEOUT_MS = 30_000;   // 2 nước đầu chưa tính giờ, nhưng không đi thì huỷ ván
const DISCONNECT_GRACE_MS = 45_000;     // rớt mạng quá lâu thì xử thua
const BASE_WINDOW = 100;                // chênh lệch rating ban đầu
const WINDOW_PER_SEC = 40;              // mở rộng dần theo thời gian chờ
const MAX_WINDOW = 1000;

interface PlayerInfo { accountId: string; name: string; rating: number }
interface QueueEntry { accountId: string; name: string; rating: number; tc: number; joinedAt: number }
interface LiveGame {
    id: string; red: PlayerInfo; black: PlayerInfo; tc: number;
    board: Board; turn: Color; moves: Move[]; keys: string[]; checks: boolean[];
    clock: { r: number; b: number }; lastTs: number; timer?: NodeJS.Timeout;
    drawOffer: Color | null; over: boolean; result?: string; reason?: string;
    dcTimers: Partial<Record<Color, NodeJS.Timeout>>;
}

const acctRoom = (id: string) => `xq:acct:${id}`;
const gameRoom = (id: string) => `xq:game:${id}`;

export const elo = (ra: number, rb: number, scoreA: number, kA: number) =>
    Math.round(kA * (scoreA - 1 / (1 + Math.pow(10, (rb - ra) / 400))));

class XiangqiServiceImpl {
    private io!: Server;
    private queue = new Map<string, QueueEntry>();
    private games = new Map<string, LiveGame>();
    private inGame = new Map<string, string>();       // accountId -> gameId
    private sockets = new Map<string, number>();      // accountId -> số socket đang mở
    private ticker?: NodeJS.Timeout;

    async init(io: Server) {
        this.io = io;
        try { // ván đang dở khi server khởi động lại không thể khôi phục -> đánh dấu huỷ
            await AppDataSource.getRepository(XiangqiGames).update({ status: "active" }, { status: "aborted", reason: "server_restart", endedAt: new Date() });
        } catch (e) { console.error("[xiangqi] cleanup", e); }
        this.ticker = setInterval(() => this.matchTick(), 1000);
        this.ticker.unref?.();
    }

    stop() { if (this.ticker) clearInterval(this.ticker); }

    // ---------- người chơi ----------
    async getPlayer(accountId: string): Promise<XiangqiPlayers> {
        const repo = AppDataSource.getRepository(XiangqiPlayers);
        let p = await repo.findOne({ where: { accountId } });
        if (!p) {
            try { p = await repo.save(repo.create({ accountId })); }
            catch { p = await repo.findOneOrFail({ where: { accountId } }); } // trùng do 2 request đồng thời
        }
        return p;
    }

    private async displayName(accountId: string): Promise<string> {
        const a = await AppDataSource.getRepository(Accounts).findOne({ where: { id: accountId }, relations: ["user"] });
        return a?.user?.fullName || a?.username || "Người chơi";
    }

    // ---------- kết nối socket ----------
    async attach(socket: any) {
        const accountId: string | undefined = socket.user?.accountId;
        if (!accountId) return;
        socket.join(acctRoom(accountId));
        this.sockets.set(accountId, (this.sockets.get(accountId) || 0) + 1);

        const gid = this.inGame.get(accountId);
        const g = gid && this.games.get(gid);
        if (g) { // kết nối lại: huỷ hẹn giờ rớt mạng, gửi lại trạng thái ván
            const side: Color = g.red.accountId === accountId ? "r" : "b";
            if (g.dcTimers[side]) { clearTimeout(g.dcTimers[side]); delete g.dcTimers[side]; }
            socket.join(gameRoom(g.id));
            socket.emit("xq:game:state", this.snapshot(g));
            this.io.to(gameRoom(g.id)).emit("xq:opponent", { gameId: g.id, accountId, online: true });
        }
        if (this.queue.has(accountId)) socket.emit("xq:queue:status", this.queueStatus(accountId));

        const ack = (fn: any, payload: any) => typeof fn === "function" && fn(payload);
        const guard = (handler: (data: any) => Promise<any> | any) => async (data: any, fn?: any) => {
            try { ack(fn, await handler(data || {})); }
            catch (e: any) { ack(fn, { ok: false, error: e?.message || "error" }); }
        };

        socket.on("xq:queue:join", guard(async (d) => this.joinQueue(accountId, Number(d.tc))));
        socket.on("xq:queue:leave", guard(async () => this.leaveQueue(accountId)));
        socket.on("xq:sync", guard(async () => {
            const cur = this.inGame.get(accountId);
            const game = cur && this.games.get(cur);
            if (game) { socket.join(gameRoom(game.id)); socket.emit("xq:game:state", this.snapshot(game)); }
            return { ok: true, accountId, inGame: !!game, queued: this.queue.has(accountId) };
        }));
        socket.on("xq:move", guard(async (d) => this.handleMove(accountId, String(d.gameId), d.move)));
        socket.on("xq:resign", guard(async (d) => this.resign(accountId, String(d.gameId))));
        socket.on("xq:draw:offer", guard(async (d) => this.offerDraw(accountId, String(d.gameId))));
        socket.on("xq:draw:respond", guard(async (d) => this.respondDraw(accountId, String(d.gameId), !!d.accept)));

        socket.on("disconnect", () => {
            const n = (this.sockets.get(accountId) || 1) - 1;
            if (n > 0) { this.sockets.set(accountId, n); return; }
            this.sockets.delete(accountId);
            this.queue.delete(accountId); // rời mạng thì bỏ khỏi hàng đợi
            const cur = this.inGame.get(accountId);
            const game = cur && this.games.get(cur);
            if (game && !game.over) {
                const side: Color = game.red.accountId === accountId ? "r" : "b";
                this.io.to(gameRoom(game.id)).emit("xq:opponent", { gameId: game.id, accountId, online: false, graceMs: DISCONNECT_GRACE_MS });
                game.dcTimers[side] = setTimeout(() => {
                    if (!game.over) void this.finish(game, side === "r" ? "black" : "red", "disconnect");
                }, DISCONNECT_GRACE_MS);
            }
        });
    }

    // ---------- ghép trận ----------
    async joinQueue(accountId: string, tc: number) {
        if (!TIME_CONTROLS.includes(tc)) throw new Error("Thời gian không hợp lệ");
        if (this.inGame.has(accountId)) throw new Error("Bạn đang trong một ván đấu");
        if (this.queue.has(accountId)) return { ok: true, ...this.queueStatus(accountId) };
        const [p, name] = await Promise.all([this.getPlayer(accountId), this.displayName(accountId)]);
        this.queue.set(accountId, { accountId, name, rating: p.rating, tc, joinedAt: Date.now() });
        this.io.to(acctRoom(accountId)).emit("xq:queue:status", this.queueStatus(accountId));
        return { ok: true, ...this.queueStatus(accountId) };
    }

    leaveQueue(accountId: string) {
        const had = this.queue.delete(accountId);
        this.io.to(acctRoom(accountId)).emit("xq:queue:status", { queued: false });
        return { ok: true, wasQueued: had };
    }

    private windowOf(e: QueueEntry, now: number) {
        return Math.min(MAX_WINDOW, BASE_WINDOW + WINDOW_PER_SEC * ((now - e.joinedAt) / 1000));
    }

    private queueStatus(accountId: string) {
        const e = this.queue.get(accountId);
        if (!e) return { queued: false };
        const now = Date.now();
        return { queued: true, tc: e.tc, waitedMs: now - e.joinedAt, ratingWindow: Math.round(this.windowOf(e, now)), rating: e.rating };
    }

    /** Ghép các cặp gần rating nhất, cùng mốc thời gian; cửa sổ rating giãn dần theo thời gian chờ. */
    async matchTick() {
        const now = Date.now();
        const list = [...this.queue.values()].sort((a, b) => a.joinedAt - b.joinedAt);
        const used = new Set<string>();
        for (const a of list) {
            if (used.has(a.accountId)) continue;
            let best: QueueEntry | null = null;
            for (const b of list) {
                if (b === a || used.has(b.accountId) || b.tc !== a.tc || b.accountId === a.accountId) continue;
                const diff = Math.abs(a.rating - b.rating);
                if (diff <= Math.max(this.windowOf(a, now), this.windowOf(b, now)) && (!best || diff < Math.abs(a.rating - best.rating))) best = b;
            }
            if (best) {
                used.add(a.accountId); used.add(best.accountId);
                this.queue.delete(a.accountId); this.queue.delete(best.accountId);
                try { await this.startGame(a, best); }
                catch (e) { console.error("[xiangqi] startGame", e); this.queue.set(a.accountId, a); this.queue.set(best.accountId, best); }
            }
        }
        for (const e of this.queue.values()) this.io.to(acctRoom(e.accountId)).emit("xq:queue:status", this.queueStatus(e.accountId));
    }

    private async startGame(a: QueueEntry, b: QueueEntry) {
        const [redE, blackE] = Math.random() < 0.5 ? [a, b] : [b, a];
        const id = ulid();
        const board = initialBoard();
        const g: LiveGame = {
            id, tc: a.tc,
            red: { accountId: redE.accountId, name: redE.name, rating: redE.rating },
            black: { accountId: blackE.accountId, name: blackE.name, rating: blackE.rating },
            board, turn: "r", moves: [], keys: [positionKey(board, "r")], checks: [false],
            clock: { r: a.tc * 1000, b: a.tc * 1000 }, lastTs: Date.now(), drawOffer: null, over: false, dcTimers: {},
        };
        await AppDataSource.getRepository(XiangqiGames).save({
            id, redAccountId: g.red.accountId, blackAccountId: g.black.accountId,
            redRatingBefore: g.red.rating, blackRatingBefore: g.black.rating,
            timeControl: g.tc, status: "active", moves: [],
        });
        this.games.set(id, g);
        this.inGame.set(g.red.accountId, id);
        this.inGame.set(g.black.accountId, id);
        for (const acc of [g.red.accountId, g.black.accountId]) {
            this.io.in(acctRoom(acc)).socketsJoin(gameRoom(id));
            this.io.to(acctRoom(acc)).emit("xq:match:found", { gameId: id });
        }
        this.io.to(gameRoom(id)).emit("xq:game:state", this.snapshot(g));
        this.schedule(g);
    }

    // ---------- diễn biến ván ----------
    private clocksNow(g: LiveGame) {
        const c = { ...g.clock };
        if (!g.over && g.moves.length >= 2) c[g.turn] = Math.max(0, c[g.turn] - (Date.now() - g.lastTs));
        return c;
    }

    snapshot(g: LiveGame) {
        return {
            gameId: g.id, red: g.red, black: g.black, tc: g.tc, board: g.board, turn: g.turn,
            moves: g.moves, clocks: this.clocksNow(g), serverTime: Date.now(),
            inCheck: !g.over && isInCheck(g.board, g.turn), drawOffer: g.drawOffer,
            over: g.over, result: g.result, reason: g.reason,
            firstMoveDeadline: g.moves.length < 2 ? g.lastTs + FIRST_MOVE_TIMEOUT_MS : null,
        };
    }

    private schedule(g: LiveGame) {
        if (g.timer) clearTimeout(g.timer);
        const grace = g.moves.length < 2;
        const ms = grace ? FIRST_MOVE_TIMEOUT_MS : Math.max(0, g.clock[g.turn] - (Date.now() - g.lastTs));
        g.timer = setTimeout(() => {
            if (g.over) return;
            if (grace) void this.finish(g, "aborted", "no_first_move");
            else { g.clock[g.turn] = 0; void this.finish(g, g.turn === "r" ? "black" : "red", "timeout"); }
        }, ms + 30);
    }

    private sideOf(g: LiveGame, accountId: string): Color {
        if (g.red.accountId === accountId) return "r";
        if (g.black.accountId === accountId) return "b";
        throw new Error("Bạn không thuộc ván đấu này");
    }

    private getGame(accountId: string, gameId: string): LiveGame {
        const g = this.games.get(gameId);
        if (!g || g.over) throw new Error("Ván đấu đã kết thúc");
        this.sideOf(g, accountId);
        return g;
    }

    async handleMove(accountId: string, gameId: string, move: Move) {
        const g = this.getGame(accountId, gameId);
        const side = this.sideOf(g, accountId);
        if (g.turn !== side) throw new Error("Chưa đến lượt bạn");
        const now = Date.now();
        if (g.moves.length >= 2) {
            g.clock[side] -= now - g.lastTs;
            if (g.clock[side] <= 0) { g.clock[side] = 0; await this.finish(g, side === "r" ? "black" : "red", "timeout"); throw new Error("Hết giờ"); }
        }
        if (!isLegalMove(g.board, side, move)) throw new Error("Nước đi không hợp lệ");
        const m: Move = { fr: move.fr, fc: move.fc, tr: move.tr, tc: move.tc };
        g.board = applyMove(g.board, m);
        g.moves.push(m);
        g.lastTs = now;
        g.turn = other(side);
        g.drawOffer = null;
        const check = isInCheck(g.board, g.turn);
        g.keys.push(positionKey(g.board, g.turn));
        g.checks.push(check);
        this.io.to(gameRoom(g.id)).emit("xq:game:move", {
            gameId: g.id, move: m, ply: g.moves.length, turn: g.turn, inCheck: check,
            clocks: this.clocksNow(g), serverTime: now,
        });
        const out = outcomeAfterMove(g.board, g.turn);
        if (out) { await this.finish(g, out.result, out.reason); return { ok: true }; }
        const rep = repetitionResult(g.keys, g.checks);
        if (rep) { await this.finish(g, rep.result, rep.reason); return { ok: true }; }
        if (insufficientMaterial(g.board)) { await this.finish(g, "draw", "insufficient_material"); return { ok: true }; }
        this.schedule(g);
        return { ok: true };
    }

    async resign(accountId: string, gameId: string) {
        const g = this.getGame(accountId, gameId);
        await this.finish(g, this.sideOf(g, accountId) === "r" ? "black" : "red", "resign");
        return { ok: true };
    }

    offerDraw(accountId: string, gameId: string) {
        const g = this.getGame(accountId, gameId);
        const side = this.sideOf(g, accountId);
        if (g.moves.length < 2) throw new Error("Chưa thể xin hòa lúc này");
        if (g.drawOffer) throw new Error("Đã có đề nghị hòa đang chờ");
        g.drawOffer = side;
        const opp = side === "r" ? g.black.accountId : g.red.accountId;
        this.io.to(acctRoom(opp)).emit("xq:draw:offered", { gameId: g.id, by: side });
        return { ok: true };
    }

    async respondDraw(accountId: string, gameId: string, accept: boolean) {
        const g = this.getGame(accountId, gameId);
        const side = this.sideOf(g, accountId);
        if (!g.drawOffer || g.drawOffer === side) throw new Error("Không có đề nghị hòa để trả lời");
        if (accept) { await this.finish(g, "draw", "agreement"); return { ok: true }; }
        g.drawOffer = null;
        this.io.to(gameRoom(g.id)).emit("xq:draw:declined", { gameId: g.id });
        return { ok: true };
    }

    // ---------- kết thúc & Elo ----------
    async finish(g: LiveGame, result: "red" | "black" | "draw" | "aborted", reason: string) {
        if (g.over) return;
        g.over = true;
        if (g.moves.length < 2) result = "aborted"; // chưa đủ nước đi thì không tính rating
        g.result = result; g.reason = reason;
        if (g.timer) clearTimeout(g.timer);
        Object.values(g.dcTimers).forEach((t) => t && clearTimeout(t));
        this.inGame.delete(g.red.accountId);
        this.inGame.delete(g.black.accountId);

        let ratings: any = { red: { before: g.red.rating, after: g.red.rating }, black: { before: g.black.rating, after: g.black.rating } };
        try {
            if (result !== "aborted") {
                const pr = await this.getPlayer(g.red.accountId);
                const pb = await this.getPlayer(g.black.accountId);
                const sr = result === "red" ? 1 : result === "draw" ? 0.5 : 0;
                const kr = pr.gamesPlayed < 20 ? 40 : 24;
                const kb = pb.gamesPlayed < 20 ? 40 : 24;
                const dr = elo(pr.rating, pb.rating, sr, kr);
                const db = elo(pb.rating, pr.rating, 1 - sr, kb);
                ratings = { red: { before: pr.rating, after: Math.max(100, pr.rating + dr) }, black: { before: pb.rating, after: Math.max(100, pb.rating + db) } };
                const repo = AppDataSource.getRepository(XiangqiPlayers);
                const upd = (p: XiangqiPlayers, after: number, score: number) => {
                    p.rating = after; p.gamesPlayed += 1;
                    if (score === 1) p.wins += 1; else if (score === 0) p.losses += 1; else p.draws += 1;
                    return repo.save(p);
                };
                await upd(pr, ratings.red.after, sr);
                await upd(pb, ratings.black.after, 1 - sr);
            }
            await AppDataSource.getRepository(XiangqiGames).update({ id: g.id }, {
                status: result === "aborted" ? "aborted" : "finished",
                result: result === "aborted" ? null : result, reason, moves: g.moves, endedAt: new Date(),
                redRatingAfter: ratings.red.after, blackRatingAfter: ratings.black.after,
            });
        } catch (e) { console.error("[xiangqi] finish persist", e); }

        this.io.to(gameRoom(g.id)).emit("xq:game:over", { gameId: g.id, result, reason, ratings });
        this.io.to(gameRoom(g.id)).emit("xq:game:state", this.snapshot(g));
        setTimeout(() => this.games.delete(g.id), 60_000).unref?.();
    }

    // ---------- REST helpers ----------
    async stats(accountId: string) {
        const p = await this.getPlayer(accountId);
        return { accountId, rating: p.rating, gamesPlayed: p.gamesPlayed, wins: p.wins, losses: p.losses, draws: p.draws };
    }

    async leaderboard(limit = 20) {
        return AppDataSource.getRepository(XiangqiPlayers).createQueryBuilder("p")
            .leftJoin(Accounts, "a", "a.id = p.accountId")
            .select("p.accountId", "accountId").addSelect("p.rating", "rating")
            .addSelect("p.gamesPlayed", "gamesPlayed").addSelect("p.wins", "wins")
            .addSelect("a.username", "username")
            .where("p.gamesPlayed > 0").orderBy("p.rating", "DESC").limit(limit).getRawMany();
    }

    async myGames(accountId: string, limit = 20) {
        return AppDataSource.getRepository(XiangqiGames).createQueryBuilder("g")
            .where("g.redAccountId = :id OR g.blackAccountId = :id", { id: accountId })
            .andWhere("g.status != 'active'").orderBy("g.createdAt", "DESC").limit(limit).getMany();
    }

    async gameById(id: string) {
        return AppDataSource.getRepository(XiangqiGames).findOne({ where: { id } });
    }

    activeGameOf(accountId: string) {
        const gid = this.inGame.get(accountId);
        const g = gid && this.games.get(gid);
        return g ? this.snapshot(g) : null;
    }

    counts() { return { queued: this.queue.size, games: [...this.games.values()].filter((g) => !g.over).length }; }
}

export const XiangqiService = new XiangqiServiceImpl();
