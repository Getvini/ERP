import { AppDataSource } from "../../../data-source";
import {
  AcceptanceRequests,
  AcceptanceStatus,
} from "../entities/AcceptanceRequest.entity";
import {
  Contracts,
  ContractStatus,
} from "../../contract/entities/Contract.entity";
import {
  ContractServices,
  ContractServiceStatus,
} from "../../contract/entities/ContractService.entity";
import { Users } from "../../user/entities/User.entity";
import { Tasks } from "../../task/entities/Task.entity";
import { TaskStatus, PerformerType, SubtaskPlanStatus } from "../../../shared/entities/Enums";
import { calculatePercentageRewardPlan } from "../helpers/TaskReward.helper";
import { Projects, ProjectStatus } from "../../project/entities/Project.entity";
import { NotificationService } from "../../notification/services/Notification.Service";
import { VinicoinService } from "../../../shared/services/Vinicoin.Service";
import { EntityManager, In, Not, ILike } from "typeorm";
import { UserRole } from "../../account/entities/Account.entity";
import { MemberRole, memberHasRole } from "../../project/entities/TeamMember.entity";

type AcceptanceActor = { userId?: string; role?: string };

export class AcceptanceService {
  private acceptanceRepo = AppDataSource.getRepository(AcceptanceRequests);
  private serviceRepo = AppDataSource.getRepository(ContractServices);
  private contractRepo = AppDataSource.getRepository(Contracts);
  private userRepo = AppDataSource.getRepository(Users);
  private taskRepo = AppDataSource.getRepository(Tasks);
  private projectRepo = AppDataSource.getRepository(Projects);
  private notificationService = new NotificationService();
  private vinicoinService = new VinicoinService();
  private readonly acceptanceRoles = new Set<string>([
    UserRole.BOD,
    UserRole.ADMIN,
    UserRole.ADMIN_SALE,
    UserRole.PM,
  ]);

  private httpError(message: string, statusCode: number) {
    const error: any = new Error(message);
    error.statusCode = statusCode;
    return error;
  }

  private assertAcceptanceActor(actor?: AcceptanceActor) {
    if (!actor?.userId)
      throw this.httpError(
        "Bạn cần đăng nhập bằng tài khoản nhân sự để nghiệm thu",
        401,
      );
    if (!actor.role || !this.acceptanceRoles.has(actor.role)) {
      throw this.httpError("Bạn không có quyền thực hiện nghiệm thu", 403);
    }
    return actor.userId;
  }

  private assertSubtaskPlansApproved(tasks: Tasks[] = []) {
    const parentTaskIds = new Set(
      tasks.map(task => task.parentTaskId).filter(Boolean) as string[],
    );
    const blockedParent = tasks.find(task =>
      parentTaskIds.has(task.id) &&
      task.subtaskPlanStatus &&
      task.subtaskPlanStatus !== SubtaskPlanStatus.APPROVED
    );
    if (blockedParent) {
      throw this.httpError(
        `Phương án chia subtask của công việc ${blockedParent.nickname || blockedParent.name} chưa được PM duyệt`,
        409,
      );
    }
  }

  private async getLockedRequest(
    manager: EntityManager,
    requestId: string,
    relations: string[],
  ) {
    const locked = await manager
      .createQueryBuilder(AcceptanceRequests, "request")
      .select("request.id")
      .where("request.id = :requestId", { requestId })
      .setLock("pessimistic_write")
      .getOne();
    if (!locked) throw this.httpError("Không tìm thấy yêu cầu nghiệm thu", 404);

    const request = await manager.getRepository(AcceptanceRequests).findOne({
      where: { id: requestId },
      relations,
    });
    if (!request)
      throw this.httpError("Không tìm thấy yêu cầu nghiệm thu", 404);
    if (request.status !== AcceptanceStatus.PENDING) {
      throw this.httpError("Yêu cầu này đã được xử lý", 409);
    }
    return request;
  }

  async createRequest(data: {
    serviceIds: string[];
    projectId: string;
    note?: string;
    actor?: AcceptanceActor;
  }) {
    const { serviceIds, projectId, note, actor } = data;

    if (!actor?.userId) {
      throw this.httpError("Bạn cần đăng nhập bằng tài khoản nhân sự để gửi nghiệm thu", 401);
    }

    if (!Array.isArray(serviceIds) || serviceIds.length === 0) {
      throw new Error("Danh sách dịch vụ không hợp lệ hoặc trống");
    }

    const requester = await this.userRepo.findOneBy({ id: actor.userId });
    if (!requester) throw new Error("Người yêu cầu không tồn tại");

    const project = await this.projectRepo.findOne({
      where: { id: projectId },
      relations: ["team", "team.members", "team.members.user", "team.members.roles"],
    });
    if (!project) throw new Error("Dự án không tồn tại");

    const canSendAcceptance = [
      UserRole.ADMIN,
      UserRole.BOD,
      UserRole.ADMIN_SALE,
    ].includes(actor.role as UserRole) || Boolean(project.team?.members?.some(
      (member) => member.user?.id === actor.userId &&
        memberHasRole(member, MemberRole.PROJECT_MANAGER),
    ));

    if (!canSendAcceptance) {
      throw this.httpError("Bạn không có quyền gửi yêu cầu nghiệm thu cho dự án này", 403);
    }

    if ([ProjectStatus.COMPLETED, ProjectStatus.CANCELLED].includes(project.status)) {
      throw this.httpError("Dự án đã hoàn tất hoặc đã đóng, không thể gửi yêu cầu nghiệm thu", 400);
    }
    if (project.status === ProjectStatus.ON_HOLD || Boolean(project.isOnHold)) {
      throw this.httpError(`Dự án "${project.name}" đang tạm dừng, không thể gửi yêu cầu nghiệm thu`, 409);
    }

    const services = await this.serviceRepo.find({
      where: { id: In(serviceIds) },
      relations: ["contract", "contract.project", "tasks"],
    });

    if (services.length !== serviceIds.length) {
      throw new Error("Một số hạng mục dịch vụ không tồn tại");
    }

    // 1. Generate automated name: NT-{contractCode}-{DD/MM/YYYY}
    const firstService = services[0];
    const contractCode = firstService.contract?.contractCode || "UNKNOWN";
    const now = new Date();
    const formattedDate = `${now.getDate().toString().padStart(2, "0")}/${(now.getMonth() + 1).toString().padStart(2, "0")}/${now.getFullYear()}`;
    const autoName = `NT-${contractCode}-${formattedDate}`;

    // Check if all services belong to the project
    const invalidServices = services.filter(
      (s) => s.contract?.project?.id !== projectId,
    );
    if (invalidServices.length > 0) {
      throw new Error(
        `Có ${invalidServices.length} dịch vụ không thuộc dự án đã chọn.`,
      );
    }

    // Check if all services have at least one result AND all tasks are COMPLETED
    // ALSO: Check if any service is already in AWAITING_ACCEPTANCE or COMPLETED
    for (const s of services) {
      if (s.status === ContractServiceStatus.AWAITING_ACCEPTANCE) {
        throw new Error(
          `Dịch vụ "${s.name || s.id}" đã được gửi nghiệm thu và đang chờ duyệt. Không thể gửi thêm yêu cầu mới.`,
        );
      }
      if (s.status === ContractServiceStatus.COMPLETED) {
        throw new Error(
          `Dịch vụ "${s.name || s.id}" đã hoàn thành nghiệm thu.`,
        );
      }
      if (s.status === ContractServiceStatus.CANCELLED) {
        throw new Error(`Dịch vụ "${s.name || s.id}" đã bị hủy.`);
      }

      if (!s.results || s.results.length === 0) {
        throw new Error(
          `Dịch vụ "${s.name || s.id}" chưa có kết quả nghiệm thu nội bộ.`,
        );
      }

      // Task ở trạng thái tạm dừng / đã hủy không được tính là "chưa hoàn thành"
      // — dự án đang ON_HOLD thì không bao giờ có task COMPLETED, nên nếu không
      // loại ra thì dịch vụ sẽ KHÔNG BAO GIỜ đủ điều kiện nghiệm thu.
      const blockingTasks = s.tasks?.filter(
        (t) => t.status !== TaskStatus.COMPLETED
          && t.status !== TaskStatus.INTERNAL_COMPLETED
          && t.status !== TaskStatus.ACCEPTED
          && t.status !== TaskStatus.ON_HOLD
          && t.status !== TaskStatus.CANCELLED,
      );
      if (blockingTasks && blockingTasks.length > 0) {
        throw new Error(
          `Dịch vụ "${s.name || s.id}" còn ${blockingTasks.length} công việc chưa hoàn thành. Vui lòng hoàn thành tất cả task trước khi nghiệm thu.`,
        );
      }
    }

    const request = this.acceptanceRepo.create({
      name: autoName,
      requester,
      project,
      note,
      status: AcceptanceStatus.PENDING,
      services,
      projectId, // Added this since AcceptanceRequests entity has explicit projectId: string
    });

    const savedRequest = await this.acceptanceRepo.save(request);

    // Update services status
    for (const s of services) {
      s.status = ContractServiceStatus.AWAITING_ACCEPTANCE;
      if (s.results) {
        for (const r of s.results) {
          if (r.status === "PENDING" && !r.acceptanceRequestId) {
            r.acceptanceRequestId = savedRequest.id;
          }
        }
      }
      await this.serviceRepo.save(s);
    }

    // Notify BOD (Mock: find first admin/bod user for now or common group)
    // In real app, we might notify all users with BOD role
    const bods = await this.userRepo
      .createQueryBuilder("user")
      .innerJoin("user.accounts", "account")
      .where("account.role IN (:...roles)", {
        roles: ["BOD", "ADMIN", "ADMIN_SALE", "PM"],
      })
      .getMany();

    for (const bod of bods) {
      await this.notificationService.createNotification({
        title: "Yêu cầu nghiệm thu mới",
        content: `${requester.fullName} yêu cầu nghiệm thu đợt: ${autoName} của dự án ${request.project?.name}`,
        type: "ACCEPTANCE_REQUESTED",
        recipient: bod,
        relatedEntityId: savedRequest.id,
        relatedEntityType: "AcceptanceRequest",
        link: `/acceptance/${savedRequest.id}`,
      });
    }

    return savedRequest;
  }

  async approveRequest(
    requestId: string,
    actor: AcceptanceActor,
    feedback?: string,
  ) {
    const approverId = this.assertAcceptanceActor(actor);
    return AppDataSource.transaction(async (manager) => {
      const request = await this.getLockedRequest(manager, requestId, [
        "services",
        "services.tasks",
        "services.tasks.job",
        "services.tasks.assignee",
        "services.tasks.assignee.accounts",
        "services.tasks.helper",
        "services.tasks.helper.accounts",
        "requester",
        "project",
      ]);
      const approver = await manager
        .getRepository(Users)
        .findOneBy({ id: approverId });
      if (!approver) throw this.httpError("Người duyệt không tồn tại", 404);

      if (request.project) {
        if ([ProjectStatus.COMPLETED, ProjectStatus.CANCELLED].includes(request.project.status)) {
          throw this.httpError(`Dự án "${request.project.name}" đã hoàn tất hoặc đã đóng, không thể duyệt nghiệm thu`, 400);
        }
        if (request.project.status === ProjectStatus.ON_HOLD || Boolean(request.project.isOnHold)) {
          throw this.httpError(`Dự án "${request.project.name}" đang tạm dừng, không thể duyệt nghiệm thu`, 409);
        }
      }

      request.status = AcceptanceStatus.APPROVED;
      request.approver = approver;
      request.feedback = feedback || "";
      await manager.save(request);

      for (const service of request.services) {
        this.assertSubtaskPlansApproved(service.tasks || []);
        if (service.results)
          service.results = service.results.map((result) => {
            // Chỉ cập nhật result thuộc request hiện tại, giữ nguyên lịch sử cũ
            const belongsToCurrentRequest =
              result.acceptanceRequestId === request.id ||
              !result.acceptanceRequestId;
            if (!belongsToCurrentRequest) return result;
            return {
              ...result,
              status: "APPROVED",
              acceptanceRequestId: request.id,
            };
          });
        service.status = ContractServiceStatus.COMPLETED;
        await manager.save(service);
        await manager.update(
          Tasks,
          { contractService: { id: service.id } },
          {
            status: TaskStatus.ACCEPTED,
            actualEndDate: new Date(),
          },
        );
        await this.triggerRewards(service, manager);
      }

      if (request.projectId)
        await this.syncProjectCompletionStatus(request.projectId, manager);
      await this.notificationService.createNotification(
        {
          title: "Yêu cầu nghiệm thu được DUYỆT",
          content: `Đợt nghiệm thu "${request.name}" đã được duyệt.`,
          type: "ACCEPTANCE_APPROVED",
          recipient: request.requester,
          relatedEntityId: request.id,
          relatedEntityType: "AcceptanceRequest",
        },
        manager,
      );
      return request;
    });
  }

  async rejectRequest(
    requestId: string,
    actor: AcceptanceActor,
    feedback: string,
  ) {
    const approverId = this.assertAcceptanceActor(actor);
    if (!feedback) throw this.httpError("Vui lòng nhập lý do từ chối", 400);
    return AppDataSource.transaction(async (manager) => {
      const request = await this.getLockedRequest(manager, requestId, [
        "services",
        "services.tasks",
        "requester",
        "project",
      ]);
      const approver = await manager
        .getRepository(Users)
        .findOneBy({ id: approverId });
      if (!approver) throw this.httpError("Người duyệt không tồn tại", 404);

      if (request.project) {
        if ([ProjectStatus.COMPLETED, ProjectStatus.CANCELLED].includes(request.project.status)) {
          throw this.httpError(`Dự án "${request.project.name}" đã hoàn tất hoặc đã đóng, không thể từ chối nghiệm thu`, 400);
        }
        if (request.project.status === ProjectStatus.ON_HOLD || Boolean(request.project.isOnHold)) {
          throw this.httpError(`Dự án "${request.project.name}" đang tạm dừng, không thể từ chối nghiệm thu`, 409);
        }
      }

      request.status = AcceptanceStatus.REJECTED;
      request.approver = approver;
      request.feedback = feedback;
      await manager.save(request);
      for (const service of request.services) {
        if (service.results)
          service.results = service.results.map((result) => {
            // Chỉ cập nhật result thuộc request hiện tại, giữ nguyên lịch sử cũ
            const belongsToCurrentRequest =
              result.acceptanceRequestId === request.id ||
              !result.acceptanceRequestId;
            if (!belongsToCurrentRequest) return result;
            return {
              ...result,
              status: "REJECTED",
              feedback,
              acceptanceRequestId: request.id,
            };
          });
        service.status = ContractServiceStatus.ACCEPTANCE_REJECTED;
        service.feedback = feedback;
        await manager.save(service);
        await manager.update(
          Tasks,
          { contractService: { id: service.id } },
          { status: TaskStatus.DOING },
        );
      }
      await this.notificationService.createNotification(
        {
          title: "Yêu cầu nghiệm thu bị từ chối",
          content: `Đợt nghiệm thu "${request.name}" của dự án ${request.project?.name} bị từ chối. Lý do: ${feedback}`,
          type: "ACCEPTANCE_REJECTED",
          recipient: request.requester,
          relatedEntityId: request.id,
          relatedEntityType: "AcceptanceRequest",
          link: `/acceptance/${request.id}`,
        },
        manager,
      );
      return request;
    });
  }

  async processRequest(
    requestId: string,
    actor: AcceptanceActor,
    decisions: {
      serviceId: string;
      status: "APPROVED" | "REJECTED";
      feedback?: string;
    }[],
  ) {
    const approverId = this.assertAcceptanceActor(actor);
    return AppDataSource.transaction(async (manager) => {
      const request = await this.getLockedRequest(manager, requestId, [
        "services",
        "services.tasks",
        "services.tasks.job",
        "services.tasks.assignee",
        "services.tasks.assignee.accounts",
        "services.tasks.helper",
        "services.tasks.helper.accounts",
        "requester",
        "project",
      ]);
      const approver = await manager
        .getRepository(Users)
        .findOneBy({ id: approverId });
      if (!approver) throw this.httpError("Người duyệt không tồn tại", 404);

      if (request.project) {
        if ([ProjectStatus.COMPLETED, ProjectStatus.CANCELLED].includes(request.project.status)) {
          throw this.httpError(`Dự án "${request.project.name}" đã hoàn tất hoặc đã đóng, không thể xử lý nghiệm thu`, 400);
        }
        if (request.project.status === ProjectStatus.ON_HOLD || Boolean(request.project.isOnHold)) {
          throw this.httpError(`Dự án "${request.project.name}" đang tạm dừng, không thể xử lý nghiệm thu`, 409);
        }
      }

      let anyApproved = false;
      let anyRejectedGlobal = false;

      for (const decision of decisions) {
        const service = request.services.find(
          (s) => s.id === decision.serviceId,
        );
        if (!service) continue;

        const resultDecisions = (decision as any).resultDecisions || [];

        if (resultDecisions.length > 0) {
          // Granular approval
          if (service.results) {
            for (const rd of resultDecisions) {
              // find the LAST matching result (the newest uploaded file for this task)
              const resultsArray = [...service.results];
              resultsArray.reverse();
              const result = resultsArray.find((r) => r.taskId === rd.taskId);

              if (result) {
                // Because result is a reference to the object in the original array, mutating it here works.
                result.status = rd.status;
                result.feedback = rd.feedback;
                result.acceptanceRequestId = request.id;

                // If rejected, find the specific task and reset it for rework
                if (rd.status === "REJECTED") {
                  const task = await manager
                    .getRepository(Tasks)
                    .findOneBy({ id: rd.taskId });
                  if (task) {
                    task.status = TaskStatus.REWORKING;
                    task.reviewNote =
                      rd.feedback ||
                      "Khách hàng yêu cầu sửa lại (Nghiệm thu bị từ chối)";
                    task.actualEndDate = null; // Clear end date for rework
                    await manager.save(task);

                    // Notify assignee about rework
                    if (task.assigneeId) {
                      const assignee = await manager
                        .getRepository(Users)
                        .findOneBy({ id: task.assigneeId });
                      if (assignee) {
                        await this.notificationService.createNotification(
                          {
                            title: "Yêu cầu sửa lại (Rework)",
                            content: `Công việc "${task.nickname || task.name}" của dự án ${request.project?.name} bị từ chối nghiệm thu. Lý do: ${task.reviewNote}`,
                            type: "TASK_REJECTED",
                            recipient: assignee,
                            relatedEntityId: task.id.toString(),
                            relatedEntityType: "Task",
                            link: `/tasks/${task.id}`,
                          },
                          manager,
                        );
                      }
                    }
                  }
                } else if (rd.status === "APPROVED") {
                  // Transition to ACCEPTED if individual task is approved
                  const task = await manager
                    .getRepository(Tasks)
                    .findOneBy({ id: rd.taskId });
                  if (task) {
                    task.status = TaskStatus.ACCEPTED;
                    task.actualEndDate = new Date();
                    await manager.save(task);
                  }
                }
              }
            }
          }
        } else {
          // Traditional batch approval/rejection for the whole service
          if (decision.status === "APPROVED") {
            if (service.results) {
              service.results = service.results.map((r) => {
                const belongsToCurrentRequest =
                  r.acceptanceRequestId === request.id || !r.acceptanceRequestId;
                if (!belongsToCurrentRequest) return r;
                return { ...r, status: "APPROVED", acceptanceRequestId: request.id };
              });
            }
          } else {
            if (service.results) {
              service.results = service.results.map((r) => {
                const belongsToCurrentRequest =
                  r.acceptanceRequestId === request.id || !r.acceptanceRequestId;
                if (!belongsToCurrentRequest) return r;
                return {
                  ...r,
                  status: "REJECTED",
                  feedback: decision.feedback,
                  acceptanceRequestId: request.id,
                };
              });
            }
          }
        }

        // Extract the latest result for each task to evaluate overall status
        const latestResultsMap = new Map();
        if (service.results) {
          for (const r of service.results) {
            latestResultsMap.set(r.taskId, r);
          }
        }
        const latestResults = Array.from(latestResultsMap.values());

        // Check if ALL output tasks (those in service.results) are APPROVED based on LATEST files
        const allApproved =
          latestResults.length > 0 &&
          latestResults.every((r) => r.status === "APPROVED");

        const anyRejected = latestResults.some((r) => r.status === "REJECTED");

        if (allApproved) {
          this.assertSubtaskPlansApproved(service.tasks || []);
          service.status = ContractServiceStatus.COMPLETED;
          service.feedback = null;
          anyApproved = true;

          // Complete all remaining tasks just in case
          await manager.update(
            Tasks,
            { contractService: { id: service.id } },
            { status: TaskStatus.ACCEPTED, actualEndDate: new Date() },
          );

          // Reward Vinicoin
          await this.triggerRewards(service, manager);
        } else if (anyRejected) {
          service.status = ContractServiceStatus.ACCEPTANCE_REJECTED;
          service.feedback = decision.feedback || "Một số kết quả bị từ chối";
          anyRejectedGlobal = true;
        } else {
          // Still waiting for more results or decisions
          service.status = ContractServiceStatus.AWAITING_ACCEPTANCE;
        }

        await manager.save(service);
      }

      // Auto trigger completion check
      if (request.projectId) {
        await this.syncProjectCompletionStatus(request.projectId, manager);
      }

      // Update request status to PROCESSED as the batch has been handled
      request.status = AcceptanceStatus.PROCESSED;
      request.approver = approver;
      await manager.save(request);

      // Notify requester
      await this.notificationService.createNotification(
        {
          title: "Kết quả nghiệm thu",
          content: `Yêu cầu nghiệm thu "${request.name}" của dự án ${request.project?.name} đã được xử lý.`,
          type: anyRejectedGlobal
            ? "ACCEPTANCE_REJECTED"
            : "ACCEPTANCE_APPROVED",
          recipient: request.requester,
          relatedEntityId: request.id,
          relatedEntityType: "AcceptanceRequest",
          link: `/acceptance/${request.id}`,
        },
        manager,
      );

      return request;
    });
  }

  async getRequest(id: string) {
    const request = await this.acceptanceRepo.findOne({
      where: { id },
      order: { createdAt: "DESC" },
      relations: [
        "services",
        "services.tasks",
        "requester",
        "approver",
        "project",
      ],
    });

    if (request && request.services) {
      request.services = request.services.map((service: any) => {
        if (!service.results || service.results.length === 0) return service;

        // Lọc chính xác theo acceptanceRequestId của request này
        const requestResults = service.results.filter(
          (r: any) => r.acceptanceRequestId === request.id,
        );

        if (requestResults.length > 0) {
          return { ...service, results: requestResults };
        }

        // Fallback thông minh cho data cũ chưa được tag acceptanceRequestId:
        // Lấy kết quả có status khớp với trạng thái request
        // (REJECTED request → kết quả REJECTED, APPROVED → APPROVED, PENDING → PENDING)
        const statusMap: Record<string, string[]> = {
          [AcceptanceStatus.REJECTED]: ["REJECTED"],
          [AcceptanceStatus.APPROVED]: ["APPROVED"],
          [AcceptanceStatus.PENDING]: ["PENDING"],
          [AcceptanceStatus.PROCESSED]: ["APPROVED", "REJECTED"],
        };
        const matchingStatuses = statusMap[request.status] || [];
        const untaggedResults = service.results.filter(
          (r: any) => !r.acceptanceRequestId && matchingStatuses.includes(r.status),
        );

        if (untaggedResults.length > 0) {
          return { ...service, results: untaggedResults };
        }

        // Không tìm thấy gì → trả mảng rỗng
        return { ...service, results: [] };
      });
    }

    return request;
  }

  async getAllRequests(
    filters: {
      projectId?: string;
      search?: string;
      status?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = Number(filters.page) || 1;
    const limit = Number(filters.limit) || 10;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filters.status && filters.status !== "ALL") {
      where.status = filters.status;
    }

    if (filters.projectId) {
      where.projectId = filters.projectId;
    }

    let findOptions: any = {
      where: where,
      order: { createdAt: "DESC" },
      relations: [
        "requester",
        "approver",
        "project",
        "services",
        "services.tasks",
      ],
      take: limit,
      skip: skip,
    };

    if (filters.search) {
      const searchTerm = `%${filters.search}%`;
      findOptions.where = [
        { ...where, name: ILike(searchTerm) },
        { ...where, project: { name: ILike(searchTerm) } },
      ];
    }

    const [items, total] = await this.acceptanceRepo.findAndCount(findOptions);

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Trả Vinicoin cho các task của một dịch vụ.
   *
   * @param allowedTaskIds Giới hạn task được thưởng.
   *   - `undefined` (mặc định) = KHÔNG giới hạn → hành vi cũ của luồng nghiệm thu.
   *   - `Set` = CHỈ các task trong tập này được thưởng. Dùng cho `closeProject()`,
   *     nơi quy tắc thưởng KHÁC luồng nghiệm thu: chỉ task gốc `COMPLETED` mới
   *     được thưởng, còn `INTERNAL_COMPLETED` giữ nguyên và KHÔNG thưởng.
   *
   * ⚠️ KHÔNG bỏ tham số này đi. Nếu `closeProject()` gọi không whitelist thì
   * các task `INTERNAL_COMPLETED` / dở dang sẽ BỊ THƯỞNG OAN — bug âm thầm
   * (không ném lỗi, chỉ sai tiền).
   */
  async triggerRewards(
    service: ContractServices,
    manager: EntityManager,
    allowedTaskIds?: Set<string>,
  ) {
    if (!service.tasks) return;

    // Nạp lại task từ DB để chắc chắn đọc TRẠNG THÁI MỚI NHẤT.
    // `service.tasks` có thể là mảng cũ trong bộ nhớ: các luồng gọi
    // `manager.update(Tasks, ...)` chỉ ghi xuống DB, KHÔNG cập nhật objects
    // đang giữ trong `service.tasks` → nếu không re-fetch, hàm sẽ chạy trên
    // dữ liệu cũ và có thể thưởng cho task chưa `ACCEPTED`.
    service.tasks = await manager.getRepository(Tasks).find({
      where: { contractService: { id: service.id } },
      relations: [
        "job",
        "assignee",
        "assignee.accounts",
        "helper",
        "helper.accounts",
        "parentTask",
        "parentTask.job",
      ],
    });

    const percentageRewards = new Map<string, number>();
    const parentRewards = new Map<string, number>();
    const subtasksByParent = new Map<string, Tasks[]>();
    for (const task of service.tasks) {
      if (allowedTaskIds && !allowedTaskIds.has(task.id)) continue;
      if (!task.parentTaskId) continue;
      const group = subtasksByParent.get(task.parentTaskId) || [];
      group.push(task);
      subtasksByParent.set(task.parentTaskId, group);
    }

    for (const [parentTaskId, subtasks] of subtasksByParent.entries()) {
      const parent = service.tasks.find(candidate => candidate.id === parentTaskId);
      const percentageSubtasks = subtasks.filter(task => Number(task.allocationPercent || 0) > 0);
      if (!parent) continue;

      const rewardPlan = calculatePercentageRewardPlan(
        Number(parent.job?.vinicoin ?? 0),
        percentageSubtasks.map(task => ({
          id: task.id,
          allocationPercent: Number(task.allocationPercent || 0),
        })),
      );
      rewardPlan.subtaskRewards.forEach((amount, taskId) => percentageRewards.set(taskId, amount));
      parentRewards.set(parent.id, rewardPlan.parentReward);
    }

    for (const task of service.tasks) {
      // Whitelist: chỉ task được phép mới tính thưởng (dùng cho closeProject)
      if (allowedTaskIds && !allowedTaskIds.has(task.id)) continue;

      const isSubtask = Boolean(task.parentTaskId);
      const childSubtasks = isSubtask ? [] : subtasksByParent.get(task.id) || [];
      const hasSubtasks = childSubtasks.length > 0;
      if (task.isRewardable === false && !hasSubtasks) continue;

      const rewardAmount = isSubtask
        ? percentageRewards.get(task.id) ?? 0
        : hasSubtasks
          ? parentRewards.get(task.id) ?? 0
          : Number(task.job?.vinicoin || 0);
      if (!rewardAmount || rewardAmount <= 0) continue;

      const rewardedAccountIds = new Set<string>();
      const assigneeAccount = task.assignee?.accounts?.[0];
      const helperAccount = task.helper?.accounts?.[0];
      if (
        assigneeAccount?.id &&
        task.performerType === PerformerType.INTERNAL
      ) {
        rewardedAccountIds.add(assigneeAccount.id);
      }
      if (!isSubtask && !hasSubtasks && helperAccount?.id && task.performerType === PerformerType.INTERNAL) {
        rewardedAccountIds.add(helperAccount.id);
      }
      for (const accountId of rewardedAccountIds) {
        await this.vinicoinService.rewardForTask(
          accountId,
          rewardAmount,
          task.id,
          service.id,
          manager,
        );
      }
      if (rewardedAccountIds.size > 0) {
        task.rewardVinicoin = rewardAmount;
        await manager.getRepository(Tasks).update(
          { id: task.id },
          { rewardVinicoin: rewardAmount },
        );
      }
    }
  }

  private async syncProjectCompletionStatus(
    projectId: string,
    manager?: EntityManager,
  ) {
    const projectRepo = manager
      ? manager.getRepository(Projects)
      : this.projectRepo;
    const contractRepo = manager
      ? manager.getRepository(Contracts)
      : this.contractRepo;
    // 1. Fetch all services of the project
    // Note: Project and Contract are 1-1, so project.contract.services is our set
    const project = await projectRepo.findOne({
      where: { id: projectId },
      relations: ["contract", "contract.services"],
    });

    if (!project || !project.contract) return;

    const services = project.contract.services || [];
    if (services.length === 0) return;

    // 2. Check if all services are COMPLETED or CANCELLED
    const allCompleted = services.every(
      (s) =>
        s.status === ContractServiceStatus.COMPLETED ||
        s.status === ContractServiceStatus.CANCELLED,
    );

    // We only move to COMPLETED if at least one service is actually COMPLETED (not just all cancelled)
    const hasCompletedService = services.some(
      (s) => s.status === ContractServiceStatus.COMPLETED,
    );

    if (allCompleted && hasCompletedService) {
      // Update Project
      project.status = ProjectStatus.COMPLETED;
      project.actualEndDate = new Date();
      await projectRepo.save(project);

      // Update Contract
      await contractRepo.update(
        { id: project.contract.id },
        { status: ContractStatus.COMPLETED },
      );
    }
  }
}
