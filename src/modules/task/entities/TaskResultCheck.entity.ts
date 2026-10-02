import { Entity, Column, OneToOne, JoinColumn } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { Tasks } from "./Task.entity";
import type { ScanRegion } from "../helpers/ScanScope.helper";
import type { QcBatchInfo } from "../../qc/services/Qc.Service";

export enum TaskResultCheckStatus {
    PENDING = "PENDING",
    RUNNING = "RUNNING",
    DONE = "DONE",
    ERROR = "ERROR"
}

@Entity()
export class TaskResultChecks extends BaseEntity {

    @Column({ type: "varchar", length: 26 })
    taskId: string;

    @OneToOne(() => Tasks)
    @JoinColumn({ name: "taskId" })
    task: Tasks;

    @Column({
        type: "enum",
        enum: TaskResultCheckStatus,
        default: TaskResultCheckStatus.PENDING
    })
    status: TaskResultCheckStatus;

    @Column({
        type: "enum",
        enum: TaskResultCheckStatus,
        default: TaskResultCheckStatus.PENDING
    })
    spellStatus: TaskResultCheckStatus;

    @Column({
        type: "enum",
        enum: TaskResultCheckStatus,
        default: TaskResultCheckStatus.PENDING
    })
    qcStatus: TaskResultCheckStatus;

    @Column({ type: "text", nullable: true })
    spellErrorMessage: string | null;

    @Column({ type: "text", nullable: true })
    qcErrorMessage: string | null;

    @Column({ type: "text", nullable: true })
    qcSkippedReason: string | null;

    @Column({ type: "simple-json", nullable: true })
    sheetNames: string[];

    @Column({ type: "simple-json", nullable: true })
    scenarioIds: string[] | null;

    @Column({ type: "simple-json", nullable: true })
    scanRegions: ScanRegion[] | null;

    @Column({ type: "varchar", nullable: true })
    filteredFileUrl: string | null;

    @Column({ type: "varchar", nullable: true })
    fileName: string | null;

    @Column({ type: "simple-json", nullable: true })
    spellErrors: { id: string; location: string; token: string; sheetName?: string | null; scenarioLabel?: string | null; scenarioId?: string | null }[];

    @Column({ type: "simple-json", nullable: true })
    qcMismatches: Record<string, any>[];

    @Column({ type: "simple-json", nullable: true })
    scannedScenarios: { id: string; sheet: string; scenarioLabel: string; startRow: number | null; endRow: number | null; colStart?: number | null; colWidth?: number | null }[] | null;

    @Column({ type: "simple-json", nullable: true })
    qcModels: { verify: string } | null;

    @Column({ type: "simple-json", nullable: true })
    qcBatches: QcBatchInfo[] | null;

    @Column({ type: "simple-json", nullable: true })
    reviewedSpellErrors: { id: string; location: string; token: string; sheetName?: string | null; scenarioLabel?: string | null; scenarioId?: string | null; confirmed: boolean }[];

    @Column({ type: "simple-json", nullable: true })
    reviewedQcMismatches: (Record<string, any> & { id: string; confirmed: boolean })[];

    @Column({ type: "simple-json", nullable: true })
    reviewerWhitelist: string[] | null;

    @Column({ type: "text", nullable: true })
    errorMessage: string | null;

    @Column({ type: "timestamptz", nullable: true })
    finalizedAt: Date | null;
}