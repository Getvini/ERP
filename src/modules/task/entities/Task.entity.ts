import { Entity, Column, ManyToOne, JoinColumn, OneToMany, Index } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { Projects } from "../../project/entities/Project.entity";
import { Jobs } from "../../job/entities/Job.entity";
import { Users } from "../../user/entities/User.entity";
import { ContractServices } from "../../contract/entities/ContractService.entity";
import { Vendors } from "../../vendor/entities/Vendor.entity";
import { TaskReviews } from "./TaskReview.entity";
import { Services } from "../../service/entities/Service.entity";
import { TaskIterations } from "./TaskIteration.entity";
import { TaskStatus, PerformerType, PricingStatus, SubtaskPlanStatus } from "../../../shared/entities/Enums";
import { Violations } from "./Violation.entity";
import { Opportunities } from "../../opportunity/entities/Opportunity.entity";
import { OpportunityServiceJobs } from "../../opportunity-service/entities/OpportunityServiceJob.entity";


@Entity()
@Index(["assigneeId", "status", "plannedEndDate"])
@Index(["project", "status"])
export class Tasks extends BaseEntity {

    @Column({ nullable: true })
    code: string;

    @Column()
    name: string;

    @Column({ type: "varchar", length: 120, nullable: true })
    nickname: string | null;

    @Index()
    @ManyToOne(() => Projects, (project) => project.tasks, { nullable: true })
    project: Projects;

    @Index()
    @Column({ type: "varchar", length: 26, nullable: true })
    parentTaskId: string | null;

    @ManyToOne(() => Tasks, (task) => task.subtasks, { nullable: true, onDelete: "RESTRICT" })
    @JoinColumn({ name: "parentTaskId" })
    parentTask: Tasks | null;

    @OneToMany(() => Tasks, (task) => task.parentTask)
    subtasks: Tasks[];
    @Column({ type: "varchar", length: 26, nullable: true })
    opportunityId: string | null;

    @ManyToOne(() => Opportunities, { nullable: true })
    @JoinColumn({ name: "opportunityId" })
    opportunity: Opportunities | null;

    @Column({ type: "varchar", length: 26, nullable: true })
    opportunityServiceJobId: string | null;

    @ManyToOne(() => OpportunityServiceJobs, (item) => item.tasks, { nullable: true, onDelete: "SET NULL" })
    @JoinColumn({ name: "opportunityServiceJobId" })
    opportunityServiceJob: OpportunityServiceJobs | null;

    @ManyToOne(() => Jobs, (job) => job.tasks, { nullable: true })
    job: Jobs;

    @ManyToOne(() => ContractServices, (contractService) => contractService.tasks, { nullable: true })
    contractService: ContractServices;

    @Index()
    @Column({ type: "varchar", length: 26, nullable: true })
    assigneeId: string;

    @ManyToOne(() => Users, (user) => user.tasks, { nullable: true })
    @JoinColumn({ name: "assigneeId" })
    assignee: Users;

    @Column({ type: "varchar", length: 26, nullable: true })
    supervisorId: string;

    @ManyToOne(() => Users, { nullable: true })
    @JoinColumn({ name: "supervisorId" })
    supervisor: Users;

    @Column({ type: "varchar", length: 26, nullable: true })
    assignerId: string;

    @ManyToOne(() => Users, { nullable: true })
    @JoinColumn({ name: "assignerId" })
    assigner: Users;

    @Column({
        type: "enum",
        enum: PerformerType,
        default: PerformerType.INTERNAL
    })
    performerType: PerformerType;

    @ManyToOne(() => Vendors, { nullable: true })
    vendor: Vendors;

    @Index()
    @Column({
        type: "enum",
        enum: TaskStatus,
        default: TaskStatus.PENDING
    })
    status: TaskStatus;

    @Column({ type: "varchar", length: 30, nullable: true })
    statusBeforeHold: TaskStatus | null;

    @Column({ type: "json", nullable: true })
    result: {
        type: string,
        name: string,
        url?: string,
        size?: number,
        publicId?: string,
        note?: string,
        checklist?: { criteriaId?: string, label: string, description?: string, checked: boolean }[],
        sheetNames?: string[],
        scenarioLabels?: string[]
    }; // Store JSON of result (file, link, checklist, or confirmation)

    @Column({ type: "timestamptz", nullable: true })
    plannedStartDate: Date;

    @Index()
    @Column({ type: "timestamptz", nullable: true })
    plannedEndDate: Date;

    @Column({ type: "json", nullable: true })
    deadlineChangeHistory: {
        oldDeadline: Date | string | null,
        newDeadline: Date | string,
        reason: string,
        changedAt: Date | string,
        changedById?: string | null,
        changedByName?: string | null
    }[] | null;

    @Column({ type: "timestamptz", nullable: true })
    actualStartDate: Date;

    @Index()
    @Column({ type: "timestamptz", nullable: true })
    actualEndDate: Date;

    @Column({ type: "text", nullable: true })
    description: string;

    @Column({ type: "json", nullable: true })
    attachments: { type: string, name: string, url: string, size?: number, publicId?: string }[];

    @OneToMany(() => TaskReviews, (review) => review.task)
    reviews: TaskReviews[];

    @OneToMany(() => TaskIterations, (iteration) => iteration.task)
    iterations: TaskIterations[];

    @OneToMany(() => Violations, (violation) => violation.task)
    violations: Violations[];

    @Column({ default: false })
    isExtra: boolean;

    @Column({ default: false })
    isOutput: boolean;

    @Column({
        type: "enum",
        enum: PricingStatus,
        nullable: true
    })
    pricingStatus: PricingStatus;

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    sellingPrice: number;

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    cost: number;

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    spentAmount: number;

    /** Contribution share of a subtask in its parent task. */
    @Column({ type: "decimal", precision: 5, scale: 2, default: 0 })
    allocationPercent: number;

    /** Actual reward settled when acceptance succeeds; null before settlement. */
    @Column({ type: "decimal", precision: 15, scale: 3, nullable: true })
    rewardVinicoin: number | null;

    /** Final customer outcome for opportunity demo work. */
    @Column({ type: "varchar", length: 30, nullable: true })
    customerDecision: "APPROVED" | "NOT_PURCHASED" | null;

    /** Approval state of the complete subtask allocation plan (parent tasks only). */
    @Column({ type: "varchar", length: 30, nullable: true })
    subtaskPlanStatus: SubtaskPlanStatus | null;

    @Column({ type: "varchar", length: 26, nullable: true })
    subtaskPlanReviewerId: string | null;

    @Column({ type: "varchar", length: 26, nullable: true })
    subtaskPlanRequesterId: string | null;

    @Column({ type: "text", nullable: true })
    subtaskPlanReviewNote: string | null;

    /** Allows reward processing. Split parent tasks receive the unallocated budget remainder. */
    @Column({ default: true })
    isRewardable: boolean;

    @ManyToOne(() => Services)
    mappedService: Services;

    @ManyToOne("Quotations", "tasks", { nullable: true })
    quotation: any;

    @Column({ type: "text", nullable: true })
    reviewNote: string; // Persistent rejection reason

    @Column({ type: "text", nullable: true })
    reassignNote: string; // Reason for reassignment

    @Column({ default: false })
    isSupportRequested: boolean;

    @Column({ default: false })
    isSupportAccepted: boolean;

    @Column({ type: "varchar", length: 26, nullable: true })
    supportTeamId: string;

    @Column({ type: "varchar", length: 26, nullable: true })
    supportLeadId: string;

    @Index()
    @Column({ type: "varchar", length: 26, nullable: true })
    helperId: string;

    @Column({ default: false })
    isSupportReturnRequested: boolean;

    @ManyToOne(() => Users, { nullable: true })
    @JoinColumn({ name: "helperId" })
    helper: Users;

    @Column({ type: "text", nullable: true })
    supportRequestNote: string;

    @Column({ type: "varchar", length: 30, nullable: true })
    supportRequestType: "EXECUTION" | "STAFFING" | null;

    @Column({ type: "text", nullable: true })
    supportReturnNote: string;

    @Column({ type: "varchar", length: 26, nullable: true })
    lastSubmittedById: string;

    @ManyToOne(() => Users, { nullable: true })
    @JoinColumn({ name: "lastSubmittedById" })
    lastSubmittedBy: Users;

}
