import { Users } from "../entities/User.entity";
import { Accounts, UserRole } from "../../account/entities/Account.entity";
import { encrypt, CryptoHelper } from "../../../shared/helpers/helpers";
import { validateUserData } from "../validations/User.Validation";
import { AppDataSource } from "../../../data-source";
import { RedisService } from "../../../shared/services/Redis.Service";
import { WorkloadService } from "../../../shared/services/Workload.Service";
import { userEmitter, USER_EVENTS } from "../events/UserEmitter";

type UserViewer = { id?: string; userId?: string; role?: string };

const LABOR_CONTRACT_MANAGER_ROLES = [UserRole.BOD, UserRole.ADMIN, UserRole.ADMIN_SALE];

export class UserService {
    private userRepository = AppDataSource.getRepository(Users);
    private accountRepository = AppDataSource.getRepository(Accounts);
    private workloadService = new WorkloadService();

    private getCacheKey(key: string) {
        return key;
    }

    private canViewSensitiveData(user: Users | any, viewer?: UserViewer) {
        if (!viewer) return false;
        if (LABOR_CONTRACT_MANAGER_ROLES.includes(viewer.role as UserRole)) return true;
        return Boolean(viewer.userId && viewer.userId === user.id);
    }

    private assertCanManageLaborContract(viewer?: UserViewer) {
        if (!LABOR_CONTRACT_MANAGER_ROLES.includes(viewer?.role as UserRole)) {
            throw new Error("Bạn không có quyền cập nhật hợp đồng lao động");
        }
    }

    private sanitizeUser(user: any, viewer?: UserViewer) {
        const canView = this.canViewSensitiveData(user, viewer);
        let idCard = canView ? (user.idCard || null) : undefined;
        if (idCard) {
            idCard = {
                idNumber: idCard.idNumber ? CryptoHelper.decryptAES(idCard.idNumber) : null,
            };
        }

        return {
            ...user,
            account: user.accounts?.[0] || user.account,
            laborContract: canView ? (user.laborContract || []) : [],
            idCard,
        };
    }

    private async getUserForMutation(id: string) {
        const user = await this.userRepository.findOne({
            where: { id },
            relations: ["accounts"]
        });

        if (!user) throw new Error("Không tìm thấy người dùng");
        return {
            ...(user as any),
            account: (user as any).accounts?.[0]
        };
    }

    async getAll(filters: { role?: string, month?: number, year?: number } = {}, viewer?: UserViewer) {
        const cacheKey = this.getCacheKey(`users:all:${filters.role || 'all'}:${filters.month || 'current'}:${filters.year || 'current'}:${viewer?.role || 'anonymous'}:${viewer?.userId || viewer?.id || 'unknown'}`);
        return await RedisService.fetchWithCache(cacheKey, 3600, async () => {
            const users = await this.userRepository.find({
                where: filters.role
                    ? { isLocked: false, accounts: { role: filters.role as any } }
                    : { isLocked: false },
                relations: ["tasks", "accounts"],
                select: {
                    id: true,
                    fullName: true,
                    phoneNumber: true,
                    birthday: true,
                    isLocked: true,
                    avatarUrl: true,
                    portfolioUrl: true,
                    hobbies: true,
                    idCard: true,
                    laborContract: true,
                    accounts: {
                        id: true,
                        username: true,
                        email: true,
                        role: true,
                        isActive: true,
                        vinicoin: true,
                        vinicoinTotal: true
                    },
                    tasks: {
                        id: true,
                        code: true,
                        name: true,
                        status: true
                    }
                }
            });
            const workloads = await this.workloadService.getWorkloadsForUsers(users.map(user => user.id), filters.month, filters.year);
            return users.map((user: any) => ({
                ...this.sanitizeUser(user, viewer),
                workload: workloads.get(user.id) || null
            }));
        });
    }

    async getOne(id: string, viewer?: UserViewer) {
        const user = await RedisService.fetchWithCache(this.getCacheKey(`users:detail:${id}:${viewer?.role || 'anonymous'}:${viewer?.userId || viewer?.id || 'unknown'}`), 3600, async () => {
            return await this.userRepository.findOne({
                where: { id, isLocked: false },
                relations: ["tasks", "accounts"],
                select: {
                    id: true,
                    fullName: true,
                    phoneNumber: true,
                    birthday: true,
                    isLocked: true,
                    avatarUrl: true,
                    portfolioUrl: true,
                    hobbies: true,
                    idCard: true,
                    laborContract: true,
                    accounts: {
                        id: true,
                        username: true,
                        email: true,
                        role: true,
                        isActive: true,
                        vinicoin: true,
                        vinicoinTotal: true
                    },
                    tasks: {
                        id: true,
                        code: true,
                        name: true,
                        status: true
                    }
                }
            });
        });

        if (!user) throw new Error("Không tìm thấy người dùng");
        return this.sanitizeUser(user as any, viewer);
    }

    async create(data: any) {
        validateUserData(data);
        const { username, password, email, fullName, phoneNumber, birthday, role, userId, isLocked } = data;

        const existingAccount = await this.accountRepository.findOne({
            where: [
                { username },
                { email }
            ]
        });

        if (existingAccount) {
            throw new Error("Tên đăng nhập hoặc email đã tồn tại");
        }

        const hashedPassword = await encrypt.encryptPassword(password || "123456");

        const account = new Accounts();
        account.username = username;
        account.password = hashedPassword;
        account.email = email;
        account.role = role || UserRole.EDITOR_D;

        let user = userId ? await this.userRepository.findOne({ where: { id: userId } }) : null;
        if (!user) {
            user = new Users();
            user.fullName = fullName;
            user.phoneNumber = phoneNumber;
        }
        if (birthday !== undefined) user.birthday = birthday || null;
        if (isLocked !== undefined) user.isLocked = isLocked;

        let savedUser: Users | null = null;
        await AppDataSource.transaction(async (transactionalEntityManager) => {
            savedUser = await transactionalEntityManager.save(user);
            account.user = savedUser;
            account.userId = savedUser.id;
            await transactionalEntityManager.save(account);
        });

        // Xóa cache danh sách khi có user mới
        await RedisService.deleteCache(this.getCacheKey('users:all*'));

        if (savedUser) userEmitter.emit(USER_EVENTS.CREATED, savedUser);

        return { message: "Tạo người dùng thành công" };
    }

    async update(id: string, data: any, viewer?: UserViewer) {
        validateUserData(data);
        const user = await this.getUserForMutation(id);
        const { fullName, phoneNumber, birthday, email, role, isActive, username, isLocked, avatarUrl, portfolioUrl, hobbies, idCard } = data;

        if (fullName !== undefined) user.fullName = fullName;
        if (phoneNumber !== undefined) user.phoneNumber = phoneNumber;
        if (birthday !== undefined) user.birthday = birthday || null;
        if (isLocked !== undefined) user.isLocked = isLocked;
        if (data.laborContract !== undefined) user.laborContract = data.laborContract;
        if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
        if (portfolioUrl !== undefined) user.portfolioUrl = portfolioUrl || null;
        if (hobbies !== undefined) user.hobbies = Array.isArray(hobbies) ? hobbies : null;
        if (idCard !== undefined) {
            if (idCard && idCard.idNumber) {
                const cleanId = String(idCard.idNumber).trim();
                user.idCard = {
                    idNumber: CryptoHelper.encryptAES(cleanId),
                };
            } else {
                user.idCard = null;
            }
        }

        const account = (user as any).account;
        if (account) {
            if (email !== undefined) account.email = email;
            if (role !== undefined) account.role = role;
            if (isActive !== undefined) account.isActive = isActive;
            if (username !== undefined) account.username = username;

            await this.accountRepository.save(account);
        }

        const savedUser = await this.userRepository.save(user);

        // Xóa cache danh sách và cache chi tiết của user vừa update
        await RedisService.deleteCache(this.getCacheKey('users:all*'));
        await RedisService.deleteCache(this.getCacheKey(`users:detail:${id}:*`));

        userEmitter.emit(USER_EVENTS.UPDATED, savedUser);

        return this.sanitizeUser(savedUser, viewer);
    }

    async updateLaborContracts(id: string, laborContract: any[], viewer?: UserViewer) {
        this.assertCanManageLaborContract(viewer);
        const user = await this.getUserForMutation(id);
        user.laborContract = laborContract || [];
        const savedUser = await this.userRepository.save(user);

        // Xóa cache danh sách và cache chi tiết của user vừa update
        await RedisService.deleteCache(this.getCacheKey('users:all*'));
        await RedisService.deleteCache(this.getCacheKey(`users:detail:${id}:*`));

        userEmitter.emit(USER_EVENTS.UPDATED, savedUser);

        return this.sanitizeUser(savedUser, viewer);
    }

    async delete(id: string) {
        const user = await this.getUserForMutation(id);

        await AppDataSource.transaction(async (transactionalEntityManager) => {
            const account = (user as any).account;
            if (account) {
                await transactionalEntityManager.remove(account);
            }
            if (!(user as any).accounts || (user as any).accounts.length <= 1) {
                await transactionalEntityManager.remove(user);
            }
        });

        // Xóa cache danh sách và cache chi tiết của user vừa xóa
        await RedisService.deleteCache(this.getCacheKey('users:all*'));
        await RedisService.deleteCache(this.getCacheKey(`users:detail:${id}:*`));

        userEmitter.emit(USER_EVENTS.DELETED, { id });

        return { message: "Xóa người dùng thành công" };
    }
}
