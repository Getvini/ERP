import { AppDataSource } from "../../../data-source";
import { SystemSettings } from "../entities/SystemSetting.entity";
import {
    QC_DEFAULT_CONFIG,
    QC_MODEL_OPTIONS,
    QC_PROVIDER_OPTIONS,
    QC_REASONING_OPTIONS,
    QC_SETTING_KEY,
    QcConfig,
    isValidQcConfig,
} from "../constants/qc";
import { WorkloadNormService } from "../../../shared/services/WorkloadNorm.Service";
import { UserRole } from "../../account/entities/Account.entity";

type Actor = { id?: string; userId?: string; role?: string };

function httpError(message: string, statusCode: number) {
    const error = new Error(message) as Error & { statusCode?: number };
    error.statusCode = statusCode;
    return error;
}

export class SettingService {
    private repository = AppDataSource.getRepository(SystemSettings);
    private workloadNormService = new WorkloadNormService();

    getQcOptions() {
        return {
            providers: QC_PROVIDER_OPTIONS,
            models: QC_MODEL_OPTIONS,
            reasoningEfforts: QC_REASONING_OPTIONS,
            defaults: QC_DEFAULT_CONFIG,
        };
    }

    async getQcConfig(): Promise<QcConfig & { isCustomized: boolean; updatedAt: Date | null }> {
        const row = await this.repository.findOne({ where: { key: QC_SETTING_KEY } });
        const stored = row?.value as Partial<QcConfig> | undefined;

        if (row && isValidQcConfig(stored)) {
            return {
                provider: stored.provider,
                verifyModel: stored.verifyModel,
                reasoningEffort: stored.reasoningEffort || QC_DEFAULT_CONFIG.reasoningEffort,
                maxBatch: stored.maxBatch,
                maxContext: stored.maxContext,
                isCustomized: true,
                updatedAt: row.updatedAt,
            };
        }

        return { ...QC_DEFAULT_CONFIG, isCustomized: false, updatedAt: null };
    }

    async updateQcConfig(input: Partial<QcConfig>, actor?: Actor) {
        if (!QC_PROVIDER_OPTIONS.some((p) => p.value === input?.provider)) {
            throw httpError("Nhà cung cấp QC không hợp lệ", 400);
        }

        const normalized: Partial<QcConfig> = {
            provider: input.provider,
            verifyModel: input.verifyModel,
            reasoningEffort: input.reasoningEffort || QC_DEFAULT_CONFIG.reasoningEffort,
            maxBatch: Number(input.maxBatch),
            maxContext: Number(input.maxContext),
        };

        if (!isValidQcConfig(normalized)) {
            throw httpError("Cấu hình QC không hợp lệ, vui lòng kiểm tra lại model và các thông số batch/context", 400);
        }

        await this.repository.save({
            key: QC_SETTING_KEY,
            value: normalized,
            updatedById: actor?.userId || null,
        });

        return this.getQcConfig();
    }

    getWorkloadNorms() {
        return this.workloadNormService.getNorms();
    }

    updateWorkloadNorms(input: { role: UserRole; monthlyNorm: number }[], actor?: Actor) {
        return this.workloadNormService.updateNorms(input, actor);
    }
}
