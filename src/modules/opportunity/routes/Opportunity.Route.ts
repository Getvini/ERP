import { Router } from "express";
import { OpportunityController } from "../controllers/Opportunity.Controller";
import { validationMiddleware } from "../../../shared/middlewares/Validation.Middleware";
import { roleMiddleware } from "../../../shared/middlewares/Role.Middleware";
import { CreateOpportunityDTO, UpdateOpportunityDTO } from "../dto/Opportunity.dto";

const router = Router();
const opportunityController = new OpportunityController();

router.get("/", opportunityController.getAll);
router.get("/:id", opportunityController.getOne);
router.post("/", validationMiddleware(CreateOpportunityDTO), opportunityController.create);
router.patch("/:id", validationMiddleware(UpdateOpportunityDTO), opportunityController.update);
router.patch("/:id/addcustomer", roleMiddleware(["BOD", "ADMIN", "BD"]), opportunityController.addCustomer);
router.patch("/:id/approve", roleMiddleware(["BOD", "ADMIN"]), opportunityController.approve);
router.patch("/:id/reject", roleMiddleware(["BOD", "ADMIN"]), opportunityController.reject);
router.delete("/:id", opportunityController.delete);

export default router;
