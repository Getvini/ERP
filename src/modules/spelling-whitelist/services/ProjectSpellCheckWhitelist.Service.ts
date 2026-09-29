import { AppDataSource } from "../../../data-source";
import { SecurityService } from "../../../shared/services/Security.Service";
import { Projects } from "../../project/entities/Project.entity";
import { ProjectSpellCheckWhitelists } from "../entities/ProjectSpellCheckWhitelist.entity";
import { ulid } from "ulid";
import { In } from "typeorm";

type Actor = { id?: string; userId?: string; role?: string };

export class ProjectSpellCheckWhitelistService {
    private projectRepository = AppDataSource.getRepository(Projects);
    private whitelistRepository = AppDataSource.getRepository(ProjectSpellCheckWhitelists);

    private httpError(message: string, statusCode: number) {
        const error = new Error(message) as Error & { statusCode?: number };
        error.statusCode = statusCode;
        return error;
    }

    private async assertProjectAccess(projectId: string, actor?: Actor) {
        if (!actor) throw this.httpError("Bạn cần đăng nhập để thực hiện hành động này", 401);

        let where: any = { id: projectId };
        try {
            const rbacWhere = SecurityService.getProjectFilters(actor as any);
            where = Array.isArray(rbacWhere)
                ? rbacWhere.map((condition) => ({ id: projectId, ...condition }))
                : { id: projectId, ...rbacWhere };
        } catch (error: any) {
            if (error.message === "FORBIDDEN_ACCESS") {
                throw this.httpError("Bạn không có quyền truy cập dự án này", 403);
            }
            throw error;
        }

        const project = await this.projectRepository.findOne({ where });
        if (!project) throw this.httpError("Không tìm thấy dự án hoặc bạn không có quyền truy cập", 404);
        return project;
    }

    async getWords(projectId: string, actor?: Actor) {
        await this.assertProjectAccess(projectId, actor);
        return this.whitelistRepository.find({
            where: { projectId },
            relations: ["addedBy"],
            order: { createdAt: "DESC" }
        });
    }

    async addWord(projectId: string, word: string, actor?: Actor) {
        await this.assertProjectAccess(projectId, actor);
        const trimmed = word.trim();
        if (!trimmed) throw this.httpError("Từ whitelist không được để trống", 400);

        const existing = await this.whitelistRepository.findOne({ where: { projectId, word: trimmed } });
        if (existing) return existing;

        const entry = this.whitelistRepository.create({
            id: ulid(),
            projectId,
            word: trimmed,
            addedById: actor?.userId || null
        });
        return this.whitelistRepository.save(entry);
    }

    async addWords(projectId: string, words: string[], actor?: Actor) {
        const results = [];
        for (const word of words) {
            results.push(await this.addWord(projectId, word, actor));
        }
        return results;
    }

    async removeWordsByText(projectId: string, words: string[], actor?: Actor) {
        await this.assertProjectAccess(projectId, actor);
        const unique = Array.from(new Set(words.map((word) => word.trim()).filter(Boolean)));
        if (unique.length === 0) return { deleted: 0 };
        const result = await this.whitelistRepository.delete({ projectId, word: In(unique) });
        return { deleted: result.affected ?? 0 };
    }

    async removeWord(projectId: string, whitelistId: string, actor?: Actor) {
        await this.assertProjectAccess(projectId, actor);
        const entry = await this.whitelistRepository.findOne({ where: { id: whitelistId, projectId } });
        if (!entry) throw this.httpError("Không tìm thấy từ trong whitelist", 404);
        await this.whitelistRepository.remove(entry);
        return { deleted: whitelistId };
    }
}
