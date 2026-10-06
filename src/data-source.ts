import "reflect-metadata";
import { DataSource } from "typeorm"
import { Accounts } from "./modules/account/entities/Account.entity"
import { Users } from "./modules/user/entities/User.entity"
import { ProjectTeams } from "./modules/project/entities/ProjectTeam.entity"
import { TeamMembers } from "./modules/project/entities/TeamMember.entity"
import { TeamMemberRoles } from "./modules/project/entities/TeamMemberRole.entity"
import { Vendors } from "./modules/vendor/entities/Vendor.entity"
import { ReferralPartners } from "./modules/referral-partner/entities/ReferralPartner.entity"
import { Customers } from "./modules/customer/entities/Customer.entity"
import { Opportunities } from "./modules/opportunity/entities/Opportunity.entity"
import { Quotations } from "./modules/quotation/entities/Quotation.entity"
import { QuotationDetails } from "./modules/quotation/entities/QuotationDetail.entity"
import { Services } from "./modules/service/entities/Service.entity"
import { Jobs } from "./modules/job/entities/Job.entity"
import { OpportunityServices } from "./modules/opportunity-service/entities/OpportunityService.entity"
import { OpportunityServiceJobs } from "./modules/opportunity-service/entities/OpportunityServiceJob.entity"
import { Contracts } from "./modules/contract/entities/Contract.entity"
import { ContractServices } from "./modules/contract/entities/ContractService.entity"
import { Projects } from "./modules/project/entities/Project.entity"
import { ProjectProductDescriptionSubmissions } from "./modules/project/entities/ProjectProductDescriptionSubmission.entity"
import { ProjectProductDescriptionItems } from "./modules/project/entities/ProjectProductDescriptionItem.entity"
import { Tasks } from "./modules/task/entities/Task.entity"
import { PaymentMilestones } from "./modules/payment-milestone/entities/PaymentMilestone.entity"
import { Debts } from "./modules/debt/entities/Debt.entity"
import { DebtPayments } from "./modules/debt/entities/DebtPayment.entity"
import { PaymentRequests } from "./modules/payment-request/entities/PaymentRequest.entity"
import { Notifications } from "./modules/notification/entities/Notification.entity"
import { Announcements } from "./modules/announcement/entities/Announcement.entity"
import { AnnouncementRecipients } from "./modules/announcement/entities/AnnouncementRecipient.entity"
import { AnnouncementComments } from "./modules/announcement/entities/AnnouncementComment.entity"
import { ContractAddendums } from "./modules/contract-addendum/entities/ContractAddendum.entity"
import { TaskReviews } from "./modules/task/entities/TaskReview.entity"
import { JobCriterias } from "./modules/job-criteria/entities/JobCriteria.entity"
import { AcceptanceRequests } from "./modules/acceptance/entities/AcceptanceRequest.entity"
import { ServicePackages } from "./modules/service-package/entities/ServicePackage.entity"
import { ServicePackageItems } from "./modules/service-package/entities/ServicePackageItem.entity"
import { OpportunityPackages } from "./modules/opportunity/entities/OpportunityPackage.entity"
import { OpportunityRejections } from "./modules/opportunity/entities/OpportunityRejection.entity"
import { TaskIterations } from "./modules/task/entities/TaskIteration.entity"
import { VinicoinTransactions } from "./modules/vinicoin/entities/VinicoinTransaction.entity"
import { Violations } from "./modules/task/entities/Violation.entity"
import { RefreshSessions } from "./modules/auth/entities/RefreshSession.entity"
import { TaskResultChecks } from "./modules/task/entities/TaskResultCheck.entity"
import { ProjectSpellCheckWhitelists } from "./modules/spelling-whitelist/entities/ProjectSpellCheckWhitelist.entity"

import { VendorJobs } from "./modules/vendor/entities/VendorJob.entity"
import { ServiceJob } from "./modules/service/entities/ServiceJob.entity"

import { AiProviders } from "./modules/ai-provider/entities/AiProvider.entity"
import { AiModels } from "./modules/ai-model/entities/AiModel.entity"
import { Assets } from "./modules/asset/entities/Asset.entity"
import { VideoGenerations } from "./modules/video-generation/entities/VideoGeneration.entity"
import { MotionGenerations } from "./modules/video-generation/entities/MotionGeneration.entity"
import { AiElements } from "./modules/ai-element/entities/AiElement.entity"
import { AiElementImages } from "./modules/ai-element/entities/AiElementImage.entity"
import { AiElementVideos } from "./modules/ai-element/entities/AiElementVideo.entity"
import { Documents } from "./modules/document-library/entities/Document.entity"
import { DocumentVersions } from "./modules/document-library/entities/DocumentVersion.entity"
import { SystemSettings } from "./modules/setting/entities/SystemSetting.entity"
import { StaffRoleWorkloadNorms } from "./modules/setting/entities/StaffRoleWorkloadNorm.entity"
import { ChatRooms } from "./modules/chat-room/entities/ChatRoom.entity"
import { ChatParticipants } from "./modules/chat-room/entities/ChatParticipant.entity"
import { ChatMessages } from "./modules/chat-room/entities/ChatMessage.entity"
import { ProjectPauseRequests } from "./modules/project/entities/ProjectPauseRequest.entity"
import { AcceptanceMinutes } from "./modules/finance-document/entities/AcceptanceMinute.entity"
import { VatInvoices } from "./modules/finance-document/entities/VatInvoice.entity"

import * as dotenv from "dotenv"
dotenv.config()

const isProduction = process.env.NODE_ENV === "production";
const useDatabaseUrl = Boolean(process.env.DATABASE_URL);
const useSsl = process.env.DB_SSL === "true";
const sslOptions = useSsl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === "true" } : false;

export const AppDataSource = new DataSource({
    type: "postgres",
    ...(isProduction
        ? { url: process.env.DATABASE_URL, ssl: sslOptions }
        : {
            host: process.env.DB_HOST || "localhost",
            port: Number(process.env.DB_PORT) || 5432,
            username: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            ssl: sslOptions
        }
    ),
    extra: {
        max: 25,
        min: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        statement_timeout: 15000,
        query_timeout: 15000,
    },
    synchronize: true,
    schema: "public",
    logging: isProduction ? false : ["error", "warn"], // Enabled some logging in dev
    entities: [
        Accounts,
        Users,
        ProjectTeams,
        TeamMembers,
        TeamMemberRoles,
        Vendors,
        ReferralPartners,
        Customers,
        Opportunities,
        Quotations,
        QuotationDetails,
        Services,
        Jobs,
        OpportunityServices,
        OpportunityServiceJobs,
        Contracts,
        ContractServices,
        Projects,
        ProjectPauseRequests,
        ProjectProductDescriptionSubmissions,
        ProjectProductDescriptionItems,
        Tasks,
        PaymentMilestones,
        Debts,
        DebtPayments,
        PaymentRequests,
        Notifications,
        Announcements,
        AnnouncementRecipients,
        AnnouncementComments,
        VendorJobs,
        ContractAddendums,
        TaskReviews,
        JobCriterias,
        AcceptanceRequests,
        ServicePackages,
        ServicePackageItems,
        OpportunityPackages,
        OpportunityRejections,
        TaskIterations,
        VinicoinTransactions,
        ServiceJob,
        Violations,
        RefreshSessions,
        TaskResultChecks,
        ProjectSpellCheckWhitelists,
        AiProviders,
        AiModels,
        Assets,
        DocumentVersions,
        Documents,
        VideoGenerations,
        MotionGenerations,
        AiElements,
        AiElementImages,
        AiElementVideos,
        SystemSettings,
        StaffRoleWorkloadNorms,
        ChatRooms,
        ChatParticipants,
        ChatMessages,
        AcceptanceMinutes,
        VatInvoices,
    ],

    migrations: [],
    subscribers: [],
})
