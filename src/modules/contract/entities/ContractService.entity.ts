import { Entity, Column, ManyToOne, OneToMany, ManyToMany, JoinColumn } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { Services } from "../../service/entities/Service.entity";
import { Jobs } from "../../job/entities/Job.entity";
import { Contracts } from "./Contract.entity";
import { OpportunityServices } from "../../opportunity-service/entities/OpportunityService.entity";
import { Tasks } from "../../task/entities/Task.entity";
import { ContractAddendums } from "../../contract-addendum/entities/ContractAddendum.entity";
import { AcceptanceRequests } from "../../acceptance/entities/AcceptanceRequest.entity";

export enum ContractServiceStatus {
    ACTIVE = "ACTIVE",
    ACCEPTANCE_REJECTED = "ACCEPTANCE_REJECTED",
    CANCELLED = "CANCELLED",
    AWAITING_ACCEPTANCE = "AWAITING_ACCEPTANCE",
    COMPLETED = "COMPLETED"
}

@Entity()
export class ContractServices extends BaseEntity {

    @ManyToOne(() => Services, (service) => service.contractServices, { nullable: true })
    @JoinColumn({ name: "serviceId" })
    service: Services;

    @Column({ type: "varchar", length: 26, nullable: true })
    serviceId: string;

    @ManyToOne(() => Jobs, { nullable: true })
    job: Jobs;

    @ManyToOne(() => Contracts, (contract) => contract.services)
    contract: Contracts;

    @Column({ type: "decimal", precision: 15, scale: 2, default: 0 })
    sellingPrice: number;

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    budget: number;

    @ManyToOne(() => OpportunityServices, (oppService) => oppService.contractServices, { nullable: true })
    opportunityService: OpportunityServices;

    @OneToMany(() => Tasks, (task) => task.contractService)
    tasks: Tasks[];

    @Column({ type: "varchar", length: 26, nullable: true })
    outputTaskId: string;

    @ManyToOne(() => Tasks, { nullable: true })
    @JoinColumn({ name: "outputTaskId" })
    outputTask: Tasks;

    @ManyToOne(() => ContractAddendums, (addendum) => addendum.services, { nullable: true })
    addendum: ContractAddendums;

    @Column({
        type: "enum",
        enum: ContractServiceStatus,
        default: ContractServiceStatus.ACTIVE
    })
    status: ContractServiceStatus;

    @ManyToMany(() => AcceptanceRequests, (acceptance) => acceptance.services)
    acceptanceRequests: AcceptanceRequests[];

    @Column({ type: "jsonb", nullable: true, default: [] })
    results: {
        taskId: string,
        type: string,
        name: string,
        url?: string,
        status: 'PENDING' | 'APPROVED' | 'REJECTED',
        feedback?: string,
        note?: string,
        checklist?: { criteriaId?: string, label: string, description?: string, checked: boolean }[],
        version?: number,
        acceptanceRequestId?: string,
        submittedAt?: string
    }[];

    @Column({ nullable: true })
    name: string; // Snapshot of service name

    @Column({ type: "varchar", length: 120, nullable: true })
    nickname: string | null;

    @Column({ nullable: true })
    code: string; // Snapshot of service code

    @Column({ nullable: true })
    packageName: string; // Snapshot of package name

    @Column({ default: false })
    isPackageService: boolean;

    @Column({ type: "text", nullable: true })
    feedback: string;
}
