import { Router } from "express";
import { UserController } from "../controllers/User.Controller";
import { roleMiddleware } from "../../../shared/middlewares/Role.Middleware";
import { validationMiddleware } from "../../../shared/middlewares/Validation.Middleware";
import { CreateUserDTO, UpdateUserDTO } from "../dto/User.dto";
import multer from "multer";

const router = Router();
const userController = new UserController();

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB
        files: 3
    }
});


router.get("/", userController.getAll);
router.get("/:id", userController.getOne);

// Only BOD, ADMIN (and ADMIN_SALE) can manage users (Create, Update, Delete)
router.post("/", roleMiddleware(["BOD", "ADMIN"]), validationMiddleware(CreateUserDTO), userController.create);
router.put("/:id", roleMiddleware(["BOD", "ADMIN", "ADMIN_SALE"]), upload.array("laborContract", 3), validationMiddleware(UpdateUserDTO), userController.update);
router.patch("/:id", roleMiddleware(["BOD", "ADMIN", "ADMIN_SALE"]), upload.array("laborContract", 3), validationMiddleware(UpdateUserDTO), userController.update);
router.patch("/:id/labor-contracts", roleMiddleware(["BOD", "ADMIN", "ADMIN_SALE"]), userController.updateLaborContracts);
router.delete("/:id", roleMiddleware(["BOD", "ADMIN"]), userController.delete);

export default router;
