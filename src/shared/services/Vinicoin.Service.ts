import { AppDataSource } from "../../data-source";
import { Accounts } from "../../modules/account/entities/Account.entity";
import { VinicoinTransactions, VinicoinTransactionType } from "../../modules/vinicoin/entities/VinicoinTransaction.entity";
import { EntityManager } from "typeorm";
import { ulid } from "ulid";

export class VinicoinService {
    /**
     * Rewards a user with vinicoins for a specific task.
     * Can be called within an existing transaction or use a new one.
     */
    async rewardForTask(
        accountId: string,
        amount: number,
        taskId: string,
        serviceId: string,
        manager?: EntityManager
    ) {
        const rewardAmount = Number(amount);
        if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) return false;

        const applyReward = async (transactionalEntityManager: EntityManager) => {
            const account = await transactionalEntityManager
                .createQueryBuilder(Accounts, "account")
                .where("account.id = :accountId", { accountId })
                .setLock("pessimistic_write")
                .getOne();
            if (!account) return false;

            const insertResult = await transactionalEntityManager
                .createQueryBuilder()
                .insert()
                .into(VinicoinTransactions)
                .values({
                    id: ulid(),
                    amount: rewardAmount,
                    account: { id: accountId } as Accounts,
                    relatedTaskId: taskId,
                    relatedServiceId: serviceId,
                    type: VinicoinTransactionType.REWARD,
                    idempotencyKey: `REWARD:${accountId}:${taskId}`,
                    description: `Thưởng vinicoin cho task: ${taskId}`
                })
                .orIgnore()
                .returning(["id"])
                .execute();

            if (!Array.isArray(insertResult.raw) || insertResult.raw.length === 0) return false;

            await transactionalEntityManager.increment(Accounts, { id: accountId }, "vinicoin", rewardAmount);
            await transactionalEntityManager.increment(Accounts, { id: accountId }, "vinicoinTotal", rewardAmount);
            return true;
        };

        return manager ? applyReward(manager) : AppDataSource.transaction(applyReward);
    }
}
