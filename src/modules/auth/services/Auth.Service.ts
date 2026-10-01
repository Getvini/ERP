import { AppDataSource } from "../../../data-source";
import { Accounts } from "../../account/entities/Account.entity";
import { Users } from "../../user/entities/User.entity";
import { encrypt } from "../../../shared/helpers/helpers";
import { RefreshSessions } from "../entities/RefreshSession.entity";
import { ulid } from "ulid";

export const SESSION_EXPIRED_CODE = "SESSION_EXPIRED";
const ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const DEFAULT_REFRESH_TTL_SECONDS = 24 * 60 * 60;
const REMEMBER_REFRESH_TTL_SECONDS = 30 * DEFAULT_REFRESH_TTL_SECONDS;

export class AuthService {
    private accountRepository = AppDataSource.getRepository(Accounts);
    private userRepository = AppDataSource.getRepository(Users);
    private refreshSessionRepository = AppDataSource.getRepository(RefreshSessions);

    async register(data: any) {
        const { username, password, email, fullName, phoneNumber, birthday } = data;

        const existingAccount = await this.accountRepository.findOne({
            where: [
                { username },
                { email }
            ]
        });

        if (existingAccount) {
            throw new Error("Tên đăng nhập hoặc email đã tồn tại");
        }

        const hashedPassword = await encrypt.encryptPassword(password);

        const account = new Accounts();
        account.username = username;
        account.password = hashedPassword;
        account.email = email;

        const user = new Users();
        user.fullName = fullName;
        user.phoneNumber = phoneNumber;
        user.birthday = birthday || null;

        await AppDataSource.transaction(async (transactionalEntityManager) => {
            const savedUser = await transactionalEntityManager.save(user);
            account.user = savedUser;
            account.userId = savedUser.id;
            await transactionalEntityManager.save(account);
        });

        return { message: "Đăng ký thành công" };
    }

    async login(data: any) {
        const { username, password } = data;

        const account = await this.accountRepository.findOne({
            where: [
                { username },
                { email: username }
            ],
            relations: ["user"]
        });

        if (!account || !account.isActive) {
            throw new Error("Tên đăng nhập hoặc mật khẩu không chính xác");
        }

        const isPasswordValid = encrypt.comparePassword(password, account.password);
        if (!isPasswordValid) {
            throw new Error("Tên đăng nhập hoặc mật khẩu không chính xác");
        }

        const user = account.user;

        const { rememberMe } = data;
        const refreshTtlSeconds = rememberMe ? REMEMBER_REFRESH_TTL_SECONDS : DEFAULT_REFRESH_TTL_SECONDS;
        const sessionId = ulid();
        const accessToken = encrypt.generateAccessToken({
            id: account.id,
            role: account.role
        }, ACCESS_TOKEN_TTL_SECONDS);
        const refreshToken = encrypt.generateRefreshToken(
            { id: account.id, sessionId },
            refreshTtlSeconds
        );

        await this.refreshSessionRepository.save(this.refreshSessionRepository.create({
            id: sessionId,
            account,
            accountId: account.id,
            tokenHash: encrypt.hashToken(refreshToken),
            expiresAt: new Date(Date.now() + refreshTtlSeconds * 1000)
        }));

        return {
            accessToken,
            refreshToken,
            accessMaxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
            refreshMaxAge: refreshTtlSeconds * 1000,
            rememberMe,
            user: {
                id: user?.id,
                fullName: user?.fullName,
                role: account.role
            }
        };
    }

    async refresh(rawRefreshToken: string | undefined) {
        if (!rawRefreshToken) throw new Error(SESSION_EXPIRED_CODE);

        let payload;
        try {
            payload = encrypt.verifyRefreshToken(rawRefreshToken);
        } catch {
            throw new Error(SESSION_EXPIRED_CODE);
        }

        if (payload.type !== "refresh" || !payload.sessionId) {
            throw new Error(SESSION_EXPIRED_CODE);
        }

        const result = await AppDataSource.transaction(async (manager) => {
            const sessionRepository = manager.getRepository(RefreshSessions);
            const lockedSession = await sessionRepository.createQueryBuilder("session")
                .where("session.id = :sessionId", { sessionId: payload.sessionId })
                .setLock("pessimistic_write")
                .getOne();

            if (!lockedSession) return null;

            const session = await sessionRepository.findOne({
                where: { id: lockedSession.id },
                relations: ["account", "account.user"]
            });

            if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;

            if (
                session.accountId !== payload.id ||
                session.tokenHash !== encrypt.hashToken(rawRefreshToken)
            ) {
                session.revokedAt = new Date();
                await sessionRepository.save(session);
                return null;
            }

            const account = session.account;
            const user = account?.user;
            if (!account?.isActive || !user?.id) {
                session.revokedAt = new Date();
                await sessionRepository.save(session);
                return null;
            }

            const remainingSeconds = Math.floor((session.expiresAt.getTime() - Date.now()) / 1000);
            if (remainingSeconds <= 0) return null;

            const accessToken = encrypt.generateAccessToken(
                { id: account.id, role: account.role },
                ACCESS_TOKEN_TTL_SECONDS
            );
            const refreshToken = encrypt.generateRefreshToken(
                { id: account.id, sessionId: session.id },
                remainingSeconds
            );
            session.tokenHash = encrypt.hashToken(refreshToken);
            await sessionRepository.save(session);

            return {
                accessToken,
                refreshToken,
                accessMaxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
                refreshMaxAge: remainingSeconds * 1000
            };
        });

        if (!result) throw new Error(SESSION_EXPIRED_CODE);
        return result;
    }

    async logout(rawRefreshToken: string | undefined) {
        if (!rawRefreshToken) return;

        try {
            const payload = encrypt.verifyRefreshToken(rawRefreshToken, true);
            if (payload.type !== "refresh" || !payload.sessionId) return;
            const session = await this.refreshSessionRepository.findOneBy({ id: payload.sessionId, accountId: payload.id });
            if (session) {
                session.revokedAt = new Date();
                await this.refreshSessionRepository.save(session);
            }
        } catch {
            // Invalid cookies are still cleared by the controller.
        }
    }

    async getMe(accountId: string) {
        const account = await this.accountRepository.findOne({
            where: { id: accountId },
            relations: ["user"]
        });

        if (!account) {
            throw new Error("Không tìm thấy tài khoản");
        }

        return {
            id: account.user?.id,
            fullName: account.user?.fullName,
            phoneNumber: account.user?.phoneNumber,
            birthday: account.user?.birthday,
            role: account.role,
            username: account.username,
            email: account.email
        };
    }
}
