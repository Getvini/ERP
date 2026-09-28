import { Request, Response } from "express";
import { AcceptanceService } from "../services/Acceptance.Service";

export class AcceptanceController {
  private acceptanceService = new AcceptanceService();

  createRequest = async (req: Request, res: Response) => {
    try {
      const result = await this.acceptanceService.createRequest({
        ...req.body,
        actor: (req as any).user,
      });
      res.status(201).json(result);
    } catch (error: any) {
      res.status(error.statusCode || 500).json({ message: error.message });
    }
  };

  approveRequest = async (req: Request, res: Response) => {
    try {
      const actor = (req as any).user;
      const feedback = req.body?.feedback;
      const result = await this.acceptanceService.approveRequest(
        req.params.id as string,
        actor,
        feedback,
      );
      res.status(200).json(result);
    } catch (error: any) {
      res.status(error.statusCode || 500).json({ message: error.message });
    }
  };

  rejectRequest = async (req: Request, res: Response) => {
    try {
      const actor = (req as any).user;
      const feedback = req.body?.feedback;
      const result = await this.acceptanceService.rejectRequest(
        req.params.id as string,
        actor,
        feedback,
      );
      res.status(200).json(result);
    } catch (error: any) {
      res.status(error.statusCode || 500).json({ message: error.message });
    }
  };

  getRequest = async (req: Request, res: Response) => {
    try {
      const result = await this.acceptanceService.getRequest(
        req.params.id as string,
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  };

  getAllRequests = async (req: Request, res: Response) => {
    try {
      const { projectId, search, status, page, limit } = req.query;
      const result = await this.acceptanceService.getAllRequests({
        projectId: projectId as string,
        search: search as string,
        status: status as string,
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      });
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  };

  processRequest = async (req: Request, res: Response) => {
    try {
      const actor = (req as any).user;
      const result = await this.acceptanceService.processRequest(
        req.params.id as string,
        actor,
        req.body.decisions,
      );
      res.status(200).json(result);
    } catch (error: any) {
      res.status(error.statusCode || 500).json({ message: error.message });
    }
  };
}
