import { Request, Response } from "express";
import fs from "fs";
import { ProjectService } from "../services/Project.Service";
import { ProjectProductDescriptionService } from "../services/ProjectProductDescription.Service";
import { AuthRequest } from "../../../shared/middlewares/Auth.Middleware";


export class ProjectController {
    private projectService = new ProjectService();
    private productDescriptionService = new ProjectProductDescriptionService();

    getAll = async (req: Request, res: Response) => {
        try {
            const userInfo = (req as any).user;
            const filters = req.query;
            const projects = await this.projectService.getAll(filters, userInfo);
            res.status(200).json(projects);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }

    getOne = async (req: Request, res: Response) => {
        try {
            const userInfo = (req as any).user;
            const project = await this.projectService.getOne(req.params.id as string, userInfo);
            res.status(200).json(project);
        } catch (error: any) {
            if (error.message === "FORBIDDEN_ACCESS" || error.message.includes("không có quyền xem")) {
                res.status(403).json({ message: error.message });
            } else {
                res.status(404).json({ message: error.message });
            }
        }
    }

    getByContract = async (req: Request, res: Response) => {
        try {
            // Usually getByContract should also have RBAC, but let's stick to getOne/getAll for now
            // as they are the main entry points
            const project = await this.projectService.getByContractId(req.params.contractId as string, (req as any).user);
            res.status(200).json(project);
        } catch (error: any) {
            res.status(error.message === "FORBIDDEN_ACCESS" ? 403 : 500).json({ message: error.message });
        }
    }


    assign = async (req: Request, res: Response) => {
        try {
            // body: { contractId, pmId, name? }
            const project = await this.projectService.assign(req.body, (req as any).user);
            res.status(201).json(project);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }

    confirm = async (req: AuthRequest, res: Response) => {
        try {
            const actor = req.user || (req as any).user;
            if (!actor) {
                return res.status(401).json({ message: "Bạn cần đăng nhập để thực hiện hành động này" });
            }

            const project = await this.projectService.confirm(req.params.id as string, actor as any);
            res.status(200).json(project);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    update = async (req: AuthRequest, res: Response) => {
        try {
            const actor = req.user || (req as any).user;
            if (!actor) {
                return res.status(401).json({ message: "Bạn cần đăng nhập để thực hiện hành động này" });
            }

            const project = await this.projectService.update(req.params.id as string, req.body, actor as any);
            res.status(200).json(project);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    getMonthlyWorkTemplate = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.getMonthlyWorkTemplate(
                req.params.id as string,
                req.query.month as string | undefined,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(500).json({ message: error.message });
        }
    }

    createMonthlyWorkAddendum = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.createMonthlyWorkAddendum(
                req.params.id as string,
                req.body,
                req.user as any
            );
            res.status(201).json(result);
        } catch (error: any) {
            res.status(500).json({ message: error.message });
        }
    }

    createServiceAddendum = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.createServiceAddendum(
                req.params.id as string,
                req.body,
                req.user as any
            );
            res.status(201).json(result);
        } catch (error: any) {
            res.status(500).json({ message: error.message });
        }
    }

    extractProductDescriptionFile = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.productDescriptionService.extractForFile(
                req.params.id as string,
                req.body?.fileUrl,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    extractProductDescriptionUpload = async (req: AuthRequest, res: Response) => {
        const file = (req as any).file as Express.Multer.File | undefined;
        try {
            if (!file) {
                return res.status(400).json({ message: "Vui lòng chọn file" });
            }
            const result = await this.productDescriptionService.extractForUpload(
                req.params.id as string,
                file,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        } finally {
            if (file?.path) fs.unlink(file.path, () => {});
        }
    }

    aiFormatProductDescription = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.productDescriptionService.aiFormat(
                req.params.id as string,
                req.body?.text,
                req.body?.productName,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }
    
    retryGoogleSheet = async (req: AuthRequest, res: Response) => {
        // Google Sheet integration is temporarily disabled.
        void req;
        res.status(503).json({ message: "Google Sheet integration is temporarily disabled" });
    }

    syncServiceJobs = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.syncServiceJobs(req.params.id as string, req.user as any);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(500).json({ message: error.message });
        }
    }

    getProductDescriptions = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.productDescriptionService.getByProject(req.params.id as string, req.user as any);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    createProductDescription = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.productDescriptionService.create(req.params.id as string, req.body, req.user as any);
            res.status(201).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    updateProductDescription = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.productDescriptionService.update(
                req.params.id as string,
                req.params.submissionId as string,
                req.body,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    submitProductDescription = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.productDescriptionService.submit(
                req.params.id as string,
                req.params.submissionId as string,
                req.body,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    approveProductDescription = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.productDescriptionService.approve(
                req.params.id as string,
                req.params.submissionId as string,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    rejectProductDescription = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.productDescriptionService.reject(
                req.params.id as string,
                req.params.submissionId as string,
                req.body,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    }

    // extractProductDescriptionFile = async (req: AuthRequest, res: Response) => {
    //     try {
    //         const result = await this.productDescriptionService.extractForFile(
    //             req.params.id as string,
    //             req.body?.fileUrl,
    //             req.user as any
    //         );
    //         res.status(200).json(result);
    //     } catch (error: any) {
    //         res.status(error.statusCode || 500).json({ message: error.message });
    //     }
    // }

    // aiFormatProductDescription = async (req: AuthRequest, res: Response) => {
    //     try {
    //         const result = await this.productDescriptionService.aiFormat(
    //             req.params.id as string,
    //             req.body?.text,
    //             req.body?.productName,
    //             req.user as any
    //         );
    //         res.status(200).json(result);
    //     } catch (error: any) {
    //         res.status(error.statusCode || 500).json({ message: error.message });
    //     }
    // }

    // start = async (req: Request, res: Response) => {
    //     try {
    //         const project = await this.projectService.start(req.params.id as string);
    //         res.status(200).json(project);
    //     } catch (error) {
    //         res.status(500).json({ message: error.message });
    //     }
    // }

    getMyProjects = async (req: AuthRequest, res: Response) => {
    try {
        const result = await this.projectService.getMyProjects({
            id: req.user!.id,
            userId: req.user!.userId,
            role: req.user!.role,
        });
        res.status(200).json(result);
    } catch (error: any) {
        res.status(500).json({ message: error.message });
    }
};

    requestStaffing = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.requestStaffing(
                req.params.id as string,
                req.body?.note,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    // ─────────────────────────────────────────────────────────────────────
    // TẠM DỪNG DỰ ÁN
    // ─────────────────────────────────────────────────────────────────────

    requestPause = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.requestPause(
                req.params.id as string,
                req.body.reason,
                req.user as any
            );
            res.status(201).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    approvePause = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.approvePause(
                req.params.requestId as string,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    rejectPause = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.rejectPause(
                req.params.requestId as string,
                req.body.feedback,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    pauseDirect = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.pauseDirect(
                req.params.id as string,
                req.body.reason,
                req.user as any
            );
            res.status(201).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    resume = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.resume(
                req.params.id as string,
                req.body?.resumeReason,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    getPauseHistory = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.getPauseHistory(req.params.id as string);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    getHoldSummary = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.getHoldSummary(req.params.id as string);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    closeDirect = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.closeDirect(
                req.params.id as string,
                req.body.reason,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    requestClose = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.requestClose(
                req.params.id as string,
                req.body?.reason,
                req.user as any
            );
            res.status(201).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    approveClose = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.approveClose(
                req.params.requestId as string,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    rejectClose = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.rejectClose(
                req.params.requestId as string,
                req.body.feedback,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    updateStatus = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.updateStatus(
                req.params.id as string,
                req.body.status,
                req.user as any
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };

    updateWorkingFiles = async (req: AuthRequest, res: Response) => {
        try {
            const result = await this.projectService.updateWorkingFiles(
                req.params.id as string,
                req.body.workingFiles,
                (req as any).user
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(error.statusCode || 500).json({ message: error.message });
        }
    };
}

