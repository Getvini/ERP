import { AppDataSource } from "../../../data-source";
import { Accounts } from "../entities/Account.entity";
import { Users } from "../../user/entities/User.entity";
import { encrypt } from "../../../shared/helpers/helpers";

export class AccountService {
    private accountRepository = AppDataSource.getRepository(Accounts);
    private userRepository = AppDataSource.getRepository(Users);

    async getAllAccounts() {
        return await this.accountRepository.find({
            where: { isActive: true },
            relations: ["user"],
            order: { createdAt: "DESC" }
        });
    }

    async getAccountById(id: string) {
        const account = await this.accountRepository.findOne({
            where: { id },
            relations: ["user"]
        });

        if (!account) {
            throw new Error("Không tìm thấy tài khoản");
        }

        return account;
    }

    async updateAccount(id: string, data: any) {
        const account = await this.accountRepository.findOne({
            where: { id },
            relations: ["user"]
        });

        if (!account) {
            throw new Error("Không tìm thấy tài khoản");
        }

        const { username, email, role, fullName, phoneNumber, birthday, isActive } = data;

        // Update Account fields
        if (username !== undefined) account.username = username;
        if (email !== undefined) account.email = email;
        if (role !== undefined) account.role = role;
        if (isActive !== undefined) account.isActive = isActive;

        // Update linked User fields if they exist
        await AppDataSource.transaction(async (transactionalEntityManager) => {
            if (account.user) {
                if (fullName !== undefined) account.user.fullName = fullName;
                if (phoneNumber !== undefined) account.user.phoneNumber = phoneNumber;
                if (birthday !== undefined) account.user.birthday = birthday || null;
                await transactionalEntityManager.save(account.user);
            }
            await transactionalEntityManager.save(account);
        });

        return "Cập nhật tài khoản thành công";
    }

    async softDeleteAccount(id: string) {
        const account = await this.accountRepository.findOne({ where: { id } });

        if (!account) {
            throw new Error("Không tìm thấy tài khoản");
        }

        account.isActive = false;
        return await this.accountRepository.save(account);
    }

    async resetPassword(id: string, newPassword: string) {
        const account = await this.accountRepository.findOne({ where: { id } });

        if (!account) {
            throw new Error("Không tìm thấy tài khoản");
        }

        const hashedPassword = await encrypt.encryptPassword(newPassword);
        account.password = hashedPassword;
        
        return await this.accountRepository.save(account);
    }
}
