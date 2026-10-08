import { AppDataSource } from "../../../data-source";
import { Accounts } from "../../account/entities/Account.entity";
import { Users } from "../../user/entities/User.entity";
import { encrypt, CryptoHelper } from "../../../shared/helpers/helpers";
import { idCardRegex } from "../../user/validations/User.Validation";

export class ProfileService {
    private accountRepository = AppDataSource.getRepository(Accounts);
    private userRepository = AppDataSource.getRepository(Users);

    async getProfile(accountId: string) {
        const account = await this.accountRepository.findOne({
            where: { id: accountId },
            relations: ["user"]
        });

        if (!account) throw new Error("Không tìm thấy tài khoản");

        const user = account.user;
        let idCard = user?.idCard;
        if (idCard) {
            idCard = {
                idNumber: idCard.idNumber ? CryptoHelper.decryptAES(idCard.idNumber) : null,
            };
        }

        return {
            id: user?.id,
            accountId: account.id,
            fullName: user?.fullName,
            phoneNumber: user?.phoneNumber,
            birthday: user?.birthday,
            avatarUrl: user?.avatarUrl,
            portfolioUrl: user?.portfolioUrl,
            hobbies: user?.hobbies,
            idCard: idCard,
            username: account.username,
            email: account.email,
            role: account.role,
            vinicoin: account.vinicoin,
            vinicoinTotal: account.vinicoinTotal,
            vinicoinWithdrawn: account.vinicoinWithdrawn
        };
    }

    async updateProfile(accountId: string, data: any) {
        const account = await this.accountRepository.findOne({
            where: { id: accountId },
            relations: ["user"]
        });

        if (!account) throw new Error("Không tìm thấy tài khoản");

        const { fullName, phoneNumber, birthday, email, password, avatarUrl, portfolioUrl, hobbies, idCard } = data;

        // 1. Update Password if provided
        if (password) {
            account.password = await encrypt.encryptPassword(password);
        }

        // 2. Update Account fields
        if (email) {
            const existing = await this.accountRepository.findOne({ where: { email } });
            if (existing && existing.id !== account.id) {
                throw new Error("Email đã được sử dụng bởi tài khoản khác");
            }
            account.email = email;
        }

        // 3. Update User fields
        await AppDataSource.transaction(async (transactionalEntityManager) => {
            if (account.user) {
                if (fullName !== undefined) account.user.fullName = fullName;
                if (phoneNumber !== undefined) account.user.phoneNumber = phoneNumber;
                if (birthday !== undefined) account.user.birthday = birthday || null;
                if (avatarUrl !== undefined) account.user.avatarUrl = avatarUrl;
                if (portfolioUrl !== undefined) account.user.portfolioUrl = portfolioUrl || null;
                if (hobbies !== undefined) account.user.hobbies = Array.isArray(hobbies) ? hobbies : null;
                if (idCard !== undefined) {
                    if (idCard && idCard.idNumber) {
                        const cleanId = String(idCard.idNumber).trim();
                        if (!cleanId.startsWith("enc:") && !idCardRegex.test(cleanId)) {
                            throw new Error("Số CCCD / CMND phải gồm đúng 9 hoặc 12 chữ số");
                        }
                        account.user.idCard = {
                            idNumber: CryptoHelper.encryptAES(cleanId),
                        };
                    } else {
                        account.user.idCard = null;
                    }
                }
                await transactionalEntityManager.save(account.user);
            }
            await transactionalEntityManager.save(account);
        });

        return this.getProfile(accountId);
    }
}
