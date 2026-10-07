import { Entity, Column, ManyToOne, ManyToMany, OneToMany } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { Vendors } from "../../vendor/entities/Vendor.entity";
import { Services } from "../../service/entities/Service.entity";
import { Tasks } from "../../task/entities/Task.entity";
import { VendorJobs } from "../../vendor/entities/VendorJob.entity";
import { JobCriterias } from "../../job-criteria/entities/JobCriteria.entity";
import { ServiceJob } from "../../service/entities/ServiceJob.entity";
import { PerformerType, JobCategory, JobLevel, JobResponsibleRole } from "../../../shared/entities/Enums";


@Entity()
export class Jobs extends BaseEntity {

    @Column()
    name: string;

    @Column({ type: "varchar", length: 120, nullable: true })
    nickname: string | null;

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    costPrice: number;

    @Column({ type: "decimal", precision: 15, scale: 3, default: 0 })
    unitPrice: number;

    @Column({ default: false })
    isBriefVideo: boolean;

    @Column({ default: true })
    isQuotationItem: boolean;

    @Column({ nullable: true })
    unit: string;

    @Column({
        type: "enum",
        enum: PerformerType,
        default: PerformerType.INTERNAL
    })
    defaultPerformerType: PerformerType;

    @OneToMany(() => VendorJobs, (vendorJob) => vendorJob.job)
    vendorJobs: VendorJobs[];

    @Column({ nullable: true })
    code: string;

    @Column({
        type: "enum",
        enum: JobCategory,
        array: true,
        default: '{}'
    })
    categories: JobCategory[];

    @Column({
        type: "enum",
        enum: JobLevel,
        default: JobLevel.A
    })
    level: JobLevel;

    @Column({
        type: "enum",
        enum: JobResponsibleRole,
        nullable: true
    })
    responsibleRole: JobResponsibleRole | null;

    @Column({ nullable: true })
    vinicoin: number;

    @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
    timeToComplete: number;

    @OneToMany(() => ServiceJob, (serviceJob) => serviceJob.job)
    serviceJobs: ServiceJob[];

    @OneToMany(() => Tasks, (task) => task.job)
    tasks: Tasks[];

    @OneToMany(() => JobCriterias, (criteria) => criteria.job, { cascade: true })
    criteria: JobCriterias[];
}
