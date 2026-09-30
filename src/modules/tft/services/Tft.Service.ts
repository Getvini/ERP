import { Server } from "socket.io";
import { ulid } from "ulid";
import { AppDataSource } from "../../../data-source";
import { Accounts } from "../../account/entities/Account.entity";
import { TftPlayers } from "../entities/TftPlayer.entity";
import { TftRuns } from "../entities/TftRun.entity";
import { CATALOG, C } from "../rules/TftData";
import { Loc, RunState, buy, buyXp, fight, move, newRun, reroll, sell, view } from "../rules/TftRun";

/**
 * Vini Tactics (PvE). Mô hình nhẹ:
 *  - Không có timer/vòng lặp nền: mọi việc chỉ chạy khi người chơi gửi thao tác.
 *  - Lượt chơi nằm trong RAM khi đang chơi; chỉ ghi DB ở đầu mỗi vòng (và khi kết thúc/rời),
 *    nên tải lại trang hoặc restart server vẫn tiếp tục được từ đầu vòng gần nhất.
 *  - Trận đấu là hàm thuần chạy 1 lần lúc bấm "Chiến đấu"; client chỉ phát lại log.
 *  - Mọi thao tác đi qua socket (không qua Express nên không chạm rate limit REST) + token bucket riêng.
 */
const IDLE_MS = 30 * 60_000;      // không thao tác 30 phút thì lưu DB và giải phóng RAM
const BUCKET_CAP = 20;            // tối đa 20 thao tác dồn nhanh
const BUCKET_REFILL_PER_SEC = 10; // bền vững 10 thao tác/giây

const acctRoom = (id: string) => `tft:acct:${id}`;

interface Live { run: RunState; accountId: string; last: number; dirty: boolean }

class TftServiceImpl {
    private io!: Server;
    private live = new Map<string, Live>();                       // accountId -> lượt chơi đang mở
    private buckets = new Map<string, { tokens: number; ts: number }>();
    private sweeper?: NodeJS.Timeout;

    init(io: Server) {
        this.io = io;
        this.sweeper = setInterval(() => void this.sweep(), 5 * 60_000);
        this.sweeper.unref?.();
    }

    stop() { if (this.sweeper) clearInterval(this.sweeper); }

    // ---------- chống spam ----------
    private allow(accountId: string) {
        const now = Date.now();
        const b = this.buckets.get(accountId) || { tokens: BUCKET_CAP, ts: now };
        b.tokens = Math.min(BUCKET_CAP, b.tokens + ((now - b.ts) / 1000) * BUCKET_REFILL_PER_SEC);
        b.ts = now;
        const ok = b.tokens >= 1;
        if (ok) b.tokens -= 1;
        this.buckets.set(accountId, b);
        return ok;
    }

    // ---------- lưu/khôi phục ----------
    private async persist(l: Live) {
        try {
            const repo = AppDataSource.getRepository(TftRuns);
            await repo.save(repo.create({
                id: l.run.id, accountId: l.accountId, seed: l.run.seed, status: l.run.status,
                round: l.run.round, wins: l.run.wins, state: l.run.status === "shop" ? l.run : null,
                endedAt: l.run.status === "shop" ? null : new Date(),
            }));
            l.dirty = false;
        } catch (e) { console.error("[tft] persist", e); }
    }

    private async load(accountId: string): Promise<Live | null> {
        const mem = this.live.get(accountId);
        if (mem) return mem;
        const row = await AppDataSource.getRepository(TftRuns).findOne({
            where: { accountId, status: "shop" }, order: { createdAt: "DESC" },
        });
        if (!row?.state) return null;
        const again = this.live.get(accountId);   // có request khác vừa nạp trong lúc chờ DB
        if (again) return again;
        const l: Live = { run: row.state as RunState, accountId, last: Date.now(), dirty: false };
        this.live.set(accountId, l);
        return l;
    }

    private async sweep() {
        const now = Date.now();
        for (const [id, l] of [...this.live]) {
            if (now - l.last < IDLE_MS) continue;
            if (l.dirty) await this.persist(l);
            this.live.delete(id);
        }
        for (const [id, b] of [...this.buckets]) if (now - b.ts > 60_000) this.buckets.delete(id);
    }

    // ---------- socket ----------
    attach(socket: any) {
        const accountId: string | undefined = socket.user?.accountId;
        if (!accountId) return;
        socket.join(acctRoom(accountId));

        const ack = (fn: any, payload: any) => typeof fn === "function" && fn(payload);
        const guard = (handler: (d: any) => Promise<any> | any) => async (data: any, fn?: any) => {
            try {
                if (!this.allow(accountId)) throw new Error("Thao tác quá nhanh, thử lại sau giây lát");
                ack(fn, await handler(data || {}));
            } catch (e: any) { ack(fn, { ok: false, error: e?.message || "error" }); }
        };

        /** Chạy 1 thao tác đồng bộ lên lượt chơi hiện tại, trả về trạng thái mới. */
        const act = (fnRun: (run: RunState) => void) => async () => {
            const l = await this.load(accountId);
            if (!l) throw new Error("Chưa có lượt chơi nào");
            fnRun(l.run);
            l.last = Date.now(); l.dirty = true;
            return { ok: true, state: view(l.run) };
        };
        const loc = (x: any): Loc => ({ z: x?.z, i: Number(x?.i) } as Loc);

        socket.on("tft:sync", guard(async () => {
            const l = await this.load(accountId);
            return { ok: true, accountId, catalog: CATALOG, state: l ? view(l.run) : null };
        }));

        socket.on("tft:start", guard(async () => {
            const cur = await this.load(accountId);
            if (cur && cur.run.status === "shop") return { ok: true, resumed: true, state: view(cur.run) };
            const l: Live = { run: newRun(ulid(), ulid()), accountId, last: Date.now(), dirty: true };
            this.live.set(accountId, l);
            await this.persist(l);
            return { ok: true, state: view(l.run) };
        }));

        socket.on("tft:abandon", guard(async () => {
            const l = await this.load(accountId);
            if (!l || l.run.status !== "shop") return { ok: true };
            l.run.status = "abandoned";
            await this.persist(l);
            await this.record(l);
            this.live.delete(accountId);
            return { ok: true };
        }));

        socket.on("tft:buy", guard((d) => act((r) => buy(r, Number(d.slot)))()));
        socket.on("tft:sell", guard((d) => act((r) => sell(r, loc(d.at)))()));
        socket.on("tft:move", guard((d) => act((r) => move(r, loc(d.from), loc(d.to)))()));
        socket.on("tft:reroll", guard(() => act((r) => reroll(r))()));
        socket.on("tft:xp", guard(() => act((r) => buyXp(r))()));

        socket.on("tft:fight", guard(async () => {
            const l = await this.load(accountId);
            if (!l) throw new Error("Chưa có lượt chơi nào");
            const out = fight(l.run);
            l.last = Date.now();
            await this.persist(l);                       // đầu vòng mới (hoặc kết thúc) thì ghi DB
            if (out.finished) await this.record(l);
            return { ok: true, state: view(l.run), battle: out.battle, win: out.win, income: out.income, finished: out.finished };
        }));
    }

    // ---------- thống kê ----------
    private async getPlayer(accountId: string): Promise<TftPlayers> {
        const repo = AppDataSource.getRepository(TftPlayers);
        let p = await repo.findOne({ where: { accountId } });
        if (!p) {
            try { p = await repo.save(repo.create({ accountId })); }
            catch { p = await repo.findOneOrFail({ where: { accountId } }); } // trùng do 2 request đồng thời
        }
        return p;
    }

    /** Ghi nhận kết quả 1 lượt chơi đã kết thúc (thắng/thua/bỏ). */
    private async record(l: Live) {
        try {
            const p = await this.getPlayer(l.accountId);
            p.runs = (p.runs || 0) + 1;
            p.battleWins = (p.battleWins || 0) + l.run.wins;
            if (l.run.status === "won") p.cleared = (p.cleared || 0) + 1;
            p.bestRound = Math.max(p.bestRound || 0, l.run.status === "won" ? C.TOTAL_ROUNDS + 1 : l.run.round);
            await AppDataSource.getRepository(TftPlayers).save(p);
        } catch (e) { console.error("[tft] record", e); }
    }

    // ---------- REST helpers ----------
    async stats(accountId: string) {
        const p = await this.getPlayer(accountId);
        return { accountId, runs: p.runs, cleared: p.cleared, bestRound: p.bestRound, battleWins: p.battleWins, totalRounds: C.TOTAL_ROUNDS };
    }

    async leaderboard(limit = 20) {
        return AppDataSource.getRepository(TftPlayers).createQueryBuilder("p")
            .leftJoin(Accounts, "a", "a.id = p.accountId")
            .select("p.accountId", "accountId").addSelect("p.bestRound", "bestRound")
            .addSelect("p.cleared", "cleared").addSelect("p.runs", "runs").addSelect("p.battleWins", "battleWins")
            .addSelect("a.username", "username")
            .where("p.runs > 0")
            .orderBy("p.bestRound", "DESC").addOrderBy("p.cleared", "DESC").addOrderBy("p.battleWins", "DESC")
            .limit(limit).getRawMany();
    }

    counts() { return { live: this.live.size }; }
}

export const TftService = new TftServiceImpl();
