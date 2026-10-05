import cron from 'node-cron';
import { AppDataSource } from '../../data-source';
import { Tasks } from '../../modules/task/entities/Task.entity';
import { TaskStatus } from '../entities/Enums';
import { Debts, DebtStatus } from '../../modules/debt/entities/Debt.entity';
import { Accounts } from '../../modules/account/entities/Account.entity';
import { Projects, ProjectStatus } from '../../modules/project/entities/Project.entity';
import { ProjectPauseService } from '../../modules/project/services/ProjectPause.Service';
import { VinicoinTransactions, VinicoinTransactionType } from '../../modules/vinicoin/entities/VinicoinTransaction.entity';
import { LessThan, MoreThan, In } from 'typeorm';
import { ulid } from 'ulid';

export class CronHelper {
    /**
     * Initializes all cron jobs for the application.
     */
    static init() {
        /**
         * Task Status Expiry Job
         * Runs every 30 minutes to check for tasks that have passed their deadline.
         */
        cron.schedule('* */6 * * *', async () => {
            console.log('[Cron] Checking for overdue tasks at', new Date().toLocaleString());
            try {
                const taskRepository = AppDataSource.getRepository(Tasks);
                const now = new Date();

                const activeStatuses = [
                    TaskStatus.PENDING,
                    TaskStatus.NOT_STARTED,
                    TaskStatus.DOING,
                    TaskStatus.REWORKING,
                    TaskStatus.AWAITING_PRICING,
                    TaskStatus.AWAITING_SUPPORT,
                    TaskStatus.SUPPORT_PENDING
                ];

                const result = await taskRepository.update(
                    {
                        status: In(activeStatuses),
                        plannedEndDate: LessThan(now)
                    },
                    {
                        status: TaskStatus.OVERDUE
                    }
                );

                if (result.affected && result.affected > 0) {
                    console.log(`[Cron] Found and updated ${result.affected} tasks to OVERDUE.`);
                }
            } catch (error) {
                console.error('[Cron] Error in overdue tasks check:', error);
            }
        });

        /**
         * Debt Status Expiry Job
         * Runs every hour to check for unpaid debts that have passed their due date.
         */
        cron.schedule('0 * * * *', async () => {
            console.log('[Cron] Checking for overdue debts at', new Date().toLocaleString());
            try {
                const debtRepository = AppDataSource.getRepository(Debts);
                const now = new Date();

                // ⚠️ KHÔNG thêm DebtStatus.LOCKED vào danh sách này.
                // Debt LOCKED thuộc dự án đã đóng — không bao giờ được tự chuyển sang OVERDUE.
                const activeDebtStatuses = [
                    DebtStatus.UNPAID,
                    DebtStatus.PARTIAL
                ];

                const result = await debtRepository.update(
                    {
                        status: In(activeDebtStatuses),
                        dueDate: LessThan(now)
                    },
                    {
                        status: DebtStatus.OVERDUE
                    }
                );

                if (result.affected && result.affected > 0) {
                    console.log(`[Cron] Found and updated ${result.affected} debts to OVERDUE.`);
                }
            } catch (error) {
                console.error('[Cron] Error in overdue debts check:', error);
            }
        });

        /**
         * Monthly Vinicoin Reset Job
         * Runs at 0:00 on the 1st day of every month.
         * Transfers available vinicoins to withdrawn total and resets available to 0.
         */
        cron.schedule('0 0 1 * *', async () => {
            console.log('[Cron] Monthly Vinicoin reset started at', new Date().toLocaleString());
            try {
                const accountRepository = AppDataSource.getRepository(Accounts);
                const periodParts = new Intl.DateTimeFormat('en-US', {
                    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit'
                }).formatToParts(new Date());
                const year = periodParts.find(part => part.type === 'year')?.value;
                const month = periodParts.find(part => part.type === 'month')?.value;
                const period = `${year}-${month}`;

                const accountsToReset = await accountRepository.find({
                    select: { id: true },
                    where: { vinicoin: MoreThan(0) }
                });

                if (accountsToReset.length === 0) {
                    console.log('[Cron] No accounts with available vinicoin to reset.');
                    return;
                }

                let processedCount = 0;
                for (const candidate of accountsToReset) {
                    const processed = await AppDataSource.transaction(async (manager) => {
                        const account = await manager.createQueryBuilder(Accounts, 'account')
                            .where('account.id = :accountId', { accountId: candidate.id })
                            .setLock('pessimistic_write')
                            .getOne();
                        const amountToWithdraw = Number(account?.vinicoin || 0);
                        if (!account || amountToWithdraw <= 0) return false;

                        const insertResult = await manager.createQueryBuilder()
                            .insert()
                            .into(VinicoinTransactions)
                            .values({
                                id: ulid(),
                                amount: amountToWithdraw,
                                account: { id: account.id } as Accounts,
                                type: VinicoinTransactionType.MONTHLY_WITHDRAWAL,
                                idempotencyKey: `MONTHLY_WITHDRAWAL:${account.id}:${period}`,
                                description: `Tự động rút Vinicoin định kỳ tháng ${period}`
                            })
                            .orIgnore()
                            .returning(['id'])
                            .execute();
                        if (!Array.isArray(insertResult.raw) || insertResult.raw.length === 0) return false;

                        await manager.increment(Accounts, { id: account.id }, 'vinicoinWithdrawn', amountToWithdraw);
                        await manager.update(Accounts, { id: account.id }, { vinicoin: 0 });
                        return true;
                    });
                    if (processed) processedCount += 1;
                }

                console.log(`[Cron] Monthly Vinicoin reset completed for ${processedCount} accounts.`);
            } catch (error) {
                console.error('[Cron] Error in monthly Vinicoin reset:', error);
            }
        }, { timezone: 'Asia/Ho_Chi_Minh' });

        /**
         * Project Auto-Close Job (D+37)
         * Chạy mỗi giờ: dự án đang tạm dừng quá 37 ngày → FORCE ĐÓNG (không qua duyệt).
         *
         * Idempotent: `forceCloseForCron` tự bỏ qua nếu dự án đã resume/đã đóng.
         */
        cron.schedule('0 * * * *', async () => {
            console.log('[Cron] Checking for projects to force-close at', new Date().toLocaleString());
            try {
                const projectRepository = AppDataSource.getRepository(Projects);
                const dueProjects = await projectRepository.find({
                    where: {
                        status: ProjectStatus.ON_HOLD,
                        autoAcceptAt: LessThan(new Date())
                    },
                    select: { id: true, name: true }
                });

                if (dueProjects.length === 0) return;

                const pauseService = new ProjectPauseService();
                let closedCount = 0;
                for (const project of dueProjects) {
                    try {
                        const result = await pauseService.forceCloseForCron(project.id);
                        if (result) closedCount += 1;
                    } catch (error) {
                        console.error(`[Cron] Lỗi force đóng dự án ${project.id}:`, error);
                    }
                }
                console.log(`[Cron] Force-closed ${closedCount}/${dueProjects.length} projects.`);
            } catch (error) {
                console.error('[Cron] Error in project auto-close job:', error);
            }
        }, { timezone: 'Asia/Ho_Chi_Minh' });

        /**
         * Project Close Reminder Job
         * Chạy 09:00 sáng giờ VN mỗi ngày: nhắc nhở trong 7 ngày cuối trước D+37.
         *
         * Người nhận: PM + BD phụ trách HĐ + BOD + ADMIN.
         * Chống gửi lặp bằng `Projects.lastReminderDate`.
         */
        cron.schedule('0 9 * * *', async () => {
            console.log('[Cron] Sending project close reminders at', new Date().toLocaleString());
            try {
                const pauseService = new ProjectPauseService();
                const sent = await pauseService.sendDailyReminders();
                console.log(`[Cron] Sent ${sent} project close reminders.`);
            } catch (error) {
                console.error('[Cron] Error in project close reminder job:', error);
            }
        }, { timezone: 'Asia/Ho_Chi_Minh' });

        console.log('[Cron] Service initialized successfully.');
    }

    /**
     * Manual trigger for testing or one-off cleanup
     */
    static async checkNow() {
        console.log('[Cron] Manual trigger: Checking for overdue tasks...');
        const taskRepository = AppDataSource.getRepository(Tasks);
        const now = new Date();
        const activeStatuses = [
            TaskStatus.PENDING,
            TaskStatus.NOT_STARTED,
            TaskStatus.DOING,
            TaskStatus.REWORKING,
            TaskStatus.AWAITING_PRICING,
            TaskStatus.AWAITING_SUPPORT,
            TaskStatus.SUPPORT_PENDING
        ];

        const result = await taskRepository.update(
            {
                status: In(activeStatuses),
                plannedEndDate: LessThan(now)
            },
            {
                status: TaskStatus.OVERDUE
            }
        );

        // Debt check
        const debtRepository = AppDataSource.getRepository(Debts);
        const activeDebtStatuses = [DebtStatus.UNPAID, DebtStatus.PARTIAL];
        const debtResult = await debtRepository.update(
            {
                status: In(activeDebtStatuses),
                dueDate: LessThan(now)
            },
            {
                status: DebtStatus.OVERDUE
            }
        );

        console.log(`[Cron] Manual check: Updated ${result.affected || 0} tasks and ${debtResult.affected || 0} debts.`);

        // Project auto-close + reminder (tính năng tạm dừng dự án)
        let closedProjects = 0;
        let remindersSent = 0;
        try {
            const pauseService = new ProjectPauseService();
            const projectRepository = AppDataSource.getRepository(Projects);
            const dueProjects = await projectRepository.find({
                where: {
                    status: ProjectStatus.ON_HOLD,
                    autoAcceptAt: LessThan(now)
                },
                select: { id: true }
            });
            for (const project of dueProjects) {
                const closed = await pauseService.forceCloseForCron(project.id);
                if (closed) closedProjects += 1;
            }
            remindersSent = await pauseService.sendDailyReminders();
        } catch (error) {
            console.error('[Cron] Manual check error in project pause jobs:', error);
        }

        console.log(`[Cron] Manual check: closed ${closedProjects} projects, sent ${remindersSent} reminders.`);
        return {
            tasks: result.affected || 0,
            debts: debtResult.affected || 0,
            closedProjects,
            remindersSent
        };
    }
}
