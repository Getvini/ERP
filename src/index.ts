import 'dotenv/config';
import "./shared/entities/Enums";

import { AppDataSource } from "./data-source"
import express from "express"
import cors from "cors"
import cookieParser from "cookie-parser"
import passport from "./shared/config/passport"

import authRoute from "./modules/auth/routes/Auth.Route"
import opportunityRoute from "./modules/opportunity/routes/Opportunity.Route"
import serviceRoute from "./modules/service/routes/Service.Route"
import jobRoute from "./modules/job/routes/Job.Route"
import contractRoute from "./modules/contract/routes/Contract.Route"
import quotationRoute from "./modules/quotation/routes/Quotation.Route"
import paymentMilestoneRoute from "./modules/payment-milestone/routes/PaymentMilestone.Route"
import projectRoute from "./modules/project/routes/Project.Route"
import taskRoute from "./modules/task/routes/Task.Route"
import opportunityServiceRoute from "./modules/opportunity-service/routes/OpportunityService.Route"
import userRoute from "./modules/user/routes/User.Route"
import projectTeamRoute from "./modules/project/routes/ProjectTeam.Route"
import notificationRoute from "./modules/notification/routes/Notification.Route"
import announcementRoute from "./modules/announcement/routes/Announcement.Route"
import dashboardRoute from "./modules/dashboard/routes/Dashboard.Route";
import customerRoute from "./modules/customer/routes/Customer.Route"
import vendorRoute from "./modules/vendor/routes/Vendor.Route"
import referralPartnerRoute from "./modules/referral-partner/routes/ReferralPartner.Route"
import debtRoute from "./modules/debt/routes/Debt.Route"
import paymentRequestRoute from "./modules/payment-request/routes/PaymentRequest.Route"
import contractAddendumRoute from "./modules/contract-addendum/routes/ContractAddendum.Route"
import jobCriteriaRoute from "./modules/job-criteria/routes/JobCriteria.Route"
import taskReviewRoute from "./modules/task/routes/TaskReview.Route"
import taskResultCheckRoute from "./modules/task/routes/TaskResultCheck.Route"
import acceptanceRoute from "./modules/acceptance/routes/Acceptance.Route"
import cloudinaryRoute from "./modules/cloudinary/routes/Cloudinary.Route"
import servicePackageRoute from "./modules/service-package/routes/ServicePackage.Route"
import chatRoute from "./modules/chat/routes/Chat.Route"
import accountRoute from "./modules/account/routes/Account.Route"
import profileRoute from "./modules/profile/routes/Profile.Route"
import spellingCheckRoute from "./modules/spelling-check/routes/SpellingCheck.Route"
import qcRoute from "./modules/qc/routes/Qc.Route"
import settingRoute from "./modules/setting/routes/Setting.Route"
import projectSpellCheckWhitelistRoute from "./modules/spelling-whitelist/routes/ProjectSpellCheckWhitelist.Route"
import { loggingMiddleware } from "./shared/middlewares/Logging.Middleware";
import { authMiddleware } from "./shared/middlewares/Auth.Middleware";
import { globalApiLimiter, writeRateLimitMiddleware } from "./shared/middlewares/RateLimit.Middleware";
import { CronHelper } from "./shared/helpers/Cron.Helper";
import { initSubscribers } from "./shared/subscribers";
import aiProviderRoute from "./modules/ai-provider/routes/AiProvider.Route"
import aiModelRoute from "./modules/ai-model/routes/AiModel.Route"
import assetRoute from "./modules/asset/routes/Asset.Route"
import videoGenerationRoute from "./modules/video-generation/routes/VideoGeneration.Route"
import aiElementRoute from "./modules/ai-element/routes/AiElement.Route"
import documentLibraryRoute from "./modules/document-library/routes/DocumentLibrary.Route"
import chatRoomRoute from "./modules/chat-room/routes/ChatRoom.Route"
import { createServer } from "http"
import { initSocket } from "./socket"
import aiDashboardRoute from "./modules/ai-dashboard/routes/AiDashboard.Route"
import paymentDashboardRoute from "./modules/payment-dashboard/routes/PaymentDashboard.Route"
import financeDocumentRoute from "./modules/finance-document/routes/FinanceDocument.Route"

const app = express()
app.set('trust proxy', 1)
app.set('etag', false)
const port = 3000
const httpServer = createServer(app)

// Mặc định 100kb là quá nhỏ cho nội dung trích xuất/AI format của tài liệu dài
app.use(express.json({ limit: "5mb" }))
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",") : [];

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        if (
            allowedOrigins.includes(origin) ||
            origin.includes("/gdt-api/tax-payer") ||
            origin.endsWith(".vercel.app") ||
            origin.endsWith(".onrender.com") ||
            /^http:\/\/localhost:\d+$/.test(origin)
        ) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true
}))
app.use(passport.initialize())

// Apply logging middleware globally
app.use(loggingMiddleware);

app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
});

app.use("/api", globalApiLimiter)

app.use("/api/auth", authRoute)
app.use("/api/opportunities", authMiddleware, writeRateLimitMiddleware, opportunityRoute)
app.use("/api/services", authMiddleware, writeRateLimitMiddleware, serviceRoute)
app.use("/api/jobs", authMiddleware, writeRateLimitMiddleware, jobRoute)
app.use("/api/contracts", authMiddleware, writeRateLimitMiddleware, contractRoute)
app.use("/api/quotations", authMiddleware, writeRateLimitMiddleware, quotationRoute)
app.use("/api/payment-milestones", authMiddleware, writeRateLimitMiddleware, paymentMilestoneRoute)
app.use("/api/projects", authMiddleware, writeRateLimitMiddleware, projectRoute)
app.use("/api/tasks", authMiddleware, writeRateLimitMiddleware, taskRoute)
app.use("/api/opportunity-services", authMiddleware, writeRateLimitMiddleware, opportunityServiceRoute)
app.use("/api/users", authMiddleware, writeRateLimitMiddleware, userRoute)
app.use("/api/teams", authMiddleware, writeRateLimitMiddleware, projectTeamRoute)
app.use("/api/notifications", authMiddleware, writeRateLimitMiddleware, notificationRoute)
app.use("/api/announcements", authMiddleware, writeRateLimitMiddleware, announcementRoute)
app.use("/api/dashboard", authMiddleware, writeRateLimitMiddleware, dashboardRoute);
app.use("/api/payment-dashboard", authMiddleware, writeRateLimitMiddleware, paymentDashboardRoute)
app.use("/api/finance-documents", authMiddleware, writeRateLimitMiddleware, financeDocumentRoute)
app.use("/api/customers", authMiddleware, writeRateLimitMiddleware, customerRoute)
app.use("/api/vendors", authMiddleware, writeRateLimitMiddleware, vendorRoute)
app.use("/api/referral-partners", authMiddleware, writeRateLimitMiddleware, referralPartnerRoute)
app.use("/api/debts", authMiddleware, writeRateLimitMiddleware, debtRoute)
app.use("/api/payment-requests", authMiddleware, writeRateLimitMiddleware, paymentRequestRoute)
app.use("/api/contract-addendums", authMiddleware, writeRateLimitMiddleware, contractAddendumRoute)
app.use("/api/job-criteria", authMiddleware, writeRateLimitMiddleware, jobCriteriaRoute)
app.use("/api/task-reviews", authMiddleware, writeRateLimitMiddleware, taskReviewRoute)
app.use("/api/task-result-checks", authMiddleware, writeRateLimitMiddleware, taskResultCheckRoute)
app.use("/api/acceptance", authMiddleware, writeRateLimitMiddleware, acceptanceRoute)
app.use("/api/cloudinary", authMiddleware, writeRateLimitMiddleware, cloudinaryRoute)
app.use("/api/service-packages", authMiddleware, writeRateLimitMiddleware, servicePackageRoute)
app.use("/api/chat", authMiddleware, writeRateLimitMiddleware, chatRoute)
app.use("/api/chat-rooms", authMiddleware, writeRateLimitMiddleware, chatRoomRoute)
app.use("/api/spelling-check", authMiddleware, writeRateLimitMiddleware, spellingCheckRoute)
app.use("/api/qc", authMiddleware, writeRateLimitMiddleware, qcRoute)
app.use("/api/settings", authMiddleware, writeRateLimitMiddleware, settingRoute)
app.use("/api/projects/:projectId/spelling-whitelist", authMiddleware, writeRateLimitMiddleware, projectSpellCheckWhitelistRoute)
app.use("/api/accounts", authMiddleware, writeRateLimitMiddleware, accountRoute)

app.use("/api/ai-providers", authMiddleware, writeRateLimitMiddleware, aiProviderRoute)
app.use("/api/ai-models", authMiddleware, writeRateLimitMiddleware, aiModelRoute)
app.use("/api/assets", authMiddleware, writeRateLimitMiddleware, assetRoute)
app.use("/api/video-generations", authMiddleware, writeRateLimitMiddleware, videoGenerationRoute)
app.use("/api/elements", authMiddleware, writeRateLimitMiddleware, aiElementRoute)
app.use("/api/document-library", authMiddleware, writeRateLimitMiddleware, documentLibraryRoute)
app.use("/api/ai-dashboard", authMiddleware, writeRateLimitMiddleware, aiDashboardRoute)

app.use("/api/me", profileRoute)

app.get("/health", (req, res) => {
    res.status(200).send("OK");
});
app.head("/health", (req, res) => {
    res.status(200).end();
});



AppDataSource.initialize().then(async () => {
    // Initialize Event Subscribers
    initSubscribers();

    initSocket(httpServer);

    httpServer.listen(port, () => {
        console.log(`Server is running on ${port}`)
        CronHelper.init();
    })

}).catch(error => console.log(error))
