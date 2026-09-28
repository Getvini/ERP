import { Request, Response } from "express";
import fs from "fs";
import { TaskService } from "../services/Task.Service";
import { uploadToCloudinary, streamUploadToCloudinary } from "../../../shared/helpers/cloudinary.helper";

export class TaskController {
    private taskService = new TaskService();

    getAll = async (req: any, res: Response) => {
        try {
            const userInfo = (req as any).user;
            const filters = req.query;
            const tasks = await this.taskService.getAll(filters, userInfo);
            res.status(200).json(tasks);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }


    getOne = async (req: Request, res: Response) => {
        try {
            const task = await this.taskService.getOne(req.params.id as string, (req as any).user);
            res.status(200).json(task);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    getDailyWorkloadByAssignee = async (req: Request, res: Response) => {
        try {
            const { startDate, endDate } = req.query;
            const result = await this.taskService.getDailyWorkloadByAssignee(
                req.params.userId as string,
                startDate as string | undefined,
                endDate as string | undefined
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }

    }

    // Trả về danh sách task theo dự án (dùng cho form chọn công việc, ví dụ: yêu cầu thanh toán).
    getByProject = async (req: any, res: Response) => {
        try {
            const userInfo = (req as any).user;
            const filters = { ...req.query, projectId: req.params.projectId, limit: req.query.limit || 500 };
            const result = await this.taskService.getAll(filters, userInfo);
            res.status(200).json(result.data);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    create = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const task = await this.taskService.create(req.body, user);
            res.status(201).json(task);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    createInternal = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const task = await this.taskService.createInternalTask(req.body, user);
            res.status(201).json(task);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    update = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const task = await this.taskService.update(req.params.id as string, req.body, user);
            res.status(200).json(task);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    updateNickname = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const task = await this.taskService.updateNickname(req.params.id as string, req.body.nickname, user);
            res.status(200).json(task);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    start = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const task = await this.taskService.start(req.params.id as string, user);
            res.status(200).json(task);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    assign = async (req: Request, res: Response) => {
        try {
            // attachments should now be pre-uploaded and sent in body
            const { attachments: bodyAttachments = [], links = [] } = req.body;

            const attachments: any[] = [...links];

            // Standardize attachments from body (both pre-uploaded files and links)
            bodyAttachments.forEach((item: any) => {
                if (typeof item === 'string') {
                    attachments.push({ type: "LINK", name: item, url: item });
                } else if (item.url) {
                    attachments.push({
                        type: item.type || "FILE",
                        name: item.name || item.url,
                        url: item.url,
                        size: item.size,
                        publicId: item.publicId
                    });
                }
            });

            const user = (req as any).user;
            const result = await this.taskService.assign(req.params.id as string, {
                ...req.body,
                attachments
            }, user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    submitResult = async (req: Request, res: Response) => {
        try {
            const taskId = req.params.id as string;
            // result is now pre-uploaded and sent in body
            const { result: bodyResult, link, sheetNames, whitelist, scenarioIds, scenarioLabels, checkFileUrl, checkFileName, draft } = req.body;
            let resultData: any = null;

            if (bodyResult && (bodyResult.type === "CHECKLIST" || bodyResult.type === "CONFIRMATION")) {
                resultData = {
                    type: bodyResult.type,
                    name: bodyResult.name || "Xac nhan hoan thanh cong viec",
                    note: bodyResult.note,
                    checklist: bodyResult.checklist || []
                };
            } else
                if (bodyResult && bodyResult.url) {
                    resultData = {
                        type: bodyResult.type || "FILE",
                        name: bodyResult.name || "Kết quả công việc",
                        url: bodyResult.url,
                        size: bodyResult.size,
                        publicId: bodyResult.publicId
                    };
                } else if (link) {
                    resultData = {
                        type: "LINK",
                        name: link,
                        url: link
                    };
                }

            if (!resultData) {
                return res.status(400).json({ message: "Vui lòng cung cấp link hoặc file kết quả" });
            }

            const user = (req as any).user;
            const result = await this.taskService.submitResult(taskId, {
                result: resultData,
                sheetNames: Array.isArray(sheetNames) ? sheetNames : undefined,
                whitelist: Array.isArray(whitelist) ? whitelist : undefined,
                scenarioIds: Array.isArray(scenarioIds) ? scenarioIds : undefined,
                scenarioLabels: Array.isArray(scenarioLabels) ? scenarioLabels : undefined,
                checkFileUrl,
                checkFileName,
                draft: draft === true || draft === "true"
            }, user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }


    submitResultFile = async (req: Request, res: Response) => {
        try {
            const taskId = req.params.id as string;
            const file = (req as any).file;
            if (!file) {
                return res.status(400).json({ message: "Vui lòng chọn file kết quả" });
            }

            const fileBuffer = await fs.promises.readFile(file.path);
            const uploaded = await streamUploadToCloudinary(file, `GETVINI/ERP/TASK/${taskId}`);

            const resultData = {
                type: "FILE",
                name: uploaded.name,
                url: uploaded.url,
                size: uploaded.size,
                publicId: uploaded.publicId
            };

            const sheetNames = String(req.body.sheetNames || "").split(",").map((s: string) => s.trim()).filter(Boolean);
            const whitelist = String(req.body.whitelist || "").split(",").map((s: string) => s.trim()).filter(Boolean);
            const scenarioIds = String(req.body.scenarioIds || "").split(",").map((s: string) => s.trim()).filter(Boolean);
            let scenarioLabels: string[] = [];
            try {
                const parsed = JSON.parse(req.body.scenarioLabels || "[]");
                if (Array.isArray(parsed)) scenarioLabels = parsed;
            } catch {
                scenarioLabels = [];
            }

            const user = (req as any).user;
            const result = await this.taskService.submitResult(taskId, {
                result: resultData,
                sheetNames,
                whitelist,
                scenarioIds,
                scenarioLabels,
                fileBuffer,
                draft: req.body.draft === true || req.body.draft === "true"
            }, user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    submitResultForReview = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const result = await this.taskService.submitSavedResultForReview(req.params.id as string, user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    delete = async (req: Request, res: Response) => {
        try {
            const result = await this.taskService.delete(req.params.id as string);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    assessExtraTask = async (req: Request, res: Response) => {
        try {
            const result = await this.taskService.assessExtraTask(req.params.id as string, req.body);
            res.status(200).json(result);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }

    reassign = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const result = await this.taskService.reassign(req.params.id as string, req.body, user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    requestSupport = async (req: Request, res: Response) => {
        try {
            const result = await this.taskService.requestSupport(req.params.id as string, req.body.note);
            res.status(200).json(result);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }

    /*
    // Deprecated cross-team support handlers
    respondToSupport = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const result = await this.taskService.respondToSupport(req.params.id as string, req.body.action, user);
            res.status(200).json(result);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }
 
    returnSupport = async (req: Request, res: Response) => {
        try {
            const result = await this.taskService.returnSupport(req.params.id as string);
            res.status(200).json(result);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }
 
    requestReturnSupport = async (req: Request, res: Response) => {
        try {
            const result = await this.taskService.requestReturnSupport(req.params.id as string, req.body.note);
            res.status(200).json(result);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }
 
    assignSupportTeam = async (req: Request, res: Response) => {
        try {
            const result = await this.taskService.assignSupportTeam(req.params.id as string, req.body.teamId);
            res.status(200).json(result);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }
    */

    rework = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const result = await this.taskService.requestRework(req.params.id as string, req.body, user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    approveByCustomer = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const result = await this.taskService.approveByCustomer(req.params.id as string, user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    customerDoesNotPurchase = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const result = await this.taskService.customerDoesNotPurchase(req.params.id as string, user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    bulkAssign = async (req: Request, res: Response) => {
        try {
            const { taskIds, attachments: bodyAttachments = [], links = [] } = req.body;
            if (!taskIds || !Array.isArray(taskIds) || taskIds.length === 0) {
                return res.status(400).json({ message: "Vui lòng chọn ít nhất một công việc" });
            }

            const attachments: any[] = [...links];
            bodyAttachments.forEach((item: any) => {
                if (typeof item === 'string') {
                    attachments.push({ type: "LINK", name: item, url: item });
                } else if (item.url) {
                    attachments.push({
                        type: item.type || "FILE",
                        name: item.name || item.url,
                        url: item.url,
                        size: item.size,
                        publicId: item.publicId
                    });
                }
            });

            const user = (req as any).user;
            const result = await this.taskService.bulkAssign(taskIds, {
                ...req.body,
                attachments
            }, user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    bulkUnassign = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const result = await this.taskService.bulkUnassign(
                req.body.projectId,
                req.body.taskIds,
                user
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    bulkStart = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const result = await this.taskService.bulkStart(
                req.body.projectId,
                req.body.taskIds,
                user
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    sendReminder = async (req: Request, res: Response) => {
        try {
            const user = (req as any).user;
            const result = await this.taskService.sendReminder(req.params.id as string, user);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    requestStaffing = async (req: Request, res: Response) => {
        try {
            const result = await this.taskService.requestStaffing(
                req.params.id as string,
                req.body.note,
                (req as any).user
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    respondStaffingRequest = async (req: Request, res: Response) => {
        try {
            const result = await this.taskService.respondStaffingRequest(
                req.params.id as string,
                req.body.action,
                (req as any).user
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    createSubtask = async (req: Request, res: Response) => {
        try {
            const result = await this.taskService.createSubtask(
                req.params.id as string,
                req.body,
                (req as any).user
            );
            res.status(201).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    updateSubtask = async (req: Request, res: Response) => {
        try {
            const result = await this.taskService.updateSubtask(
                req.params.id as string,
                req.body,
                (req as any).user
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    submitSubtaskPlan = async (req: Request, res: Response) => {
        try {
            const result = await this.taskService.submitSubtaskPlan(
                req.params.id as string,
                (req as any).user
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    respondSubtaskPlan = async (req: Request, res: Response) => {
        try {
            const result = await this.taskService.respondSubtaskPlan(
                req.params.id as string,
                req.body.action,
                req.body.note,
                (req as any).user
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }
}
