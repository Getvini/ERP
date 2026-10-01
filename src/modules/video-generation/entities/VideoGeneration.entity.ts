import {
    Entity, Column, PrimaryGeneratedColumn,
    CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn,
} from "typeorm";
import { AiModels } from "../../ai-model/entities/AiModel.entity";
import { Assets } from "../../asset/entities/Asset.entity";
import { Projects } from "../../project/entities/Project.entity";
import { Accounts } from "../../account/entities/Account.entity";
import { Tasks } from "../../task/entities/Task.entity";
import { Opportunities } from "../../opportunity/entities/Opportunity.entity";

/**
 * Maps to: public.video_generations
 *
 * project_id BẮT BUỘC trỏ về 1 Project ERP có sẵn (dự án hợp đồng thật),
 * KHÔNG tự tạo project mới cho mỗi lần generate như bản App_Video_AI_Be gốc.
 */
@Entity({ name: "video_generations" })
export class VideoGenerations {
    @PrimaryGeneratedColumn("increment", { type: "bigint" })
    id!: number;

    // ── FK columns ──────────────────────────────────────────────────────────
    @Column({ name: "project_id", type: "varchar", length: 26, nullable: true })
    projectId?: string;

    @Column({ name: "opportunity_id", type: "varchar", length: 26, nullable: true })
    opportunityId?: string;

    @Column({ name: "task_id", type: "varchar", length: 26, nullable: true })
    taskId?: string;

    @Column({ name: "model_id", type: "varchar", length: 26 })
    modelId!: string;

    @Column({ name: "user_id", type: "varchar", length: 26 })
    userId!: string;

    @Column({ name: "image_begin_asset_id", type: "bigint", nullable: true })
    imageBeginAssetId?: number;

    @Column({ name: "image_end_asset_id", type: "bigint", nullable: true })
    imageEndAssetId?: number;

    @Column({ name: "output_asset_id", type: "bigint", nullable: true })
    outputAssetId?: number;

    @Column({ name: "thumbnail_asset_id", type: "bigint", nullable: true })
    thumbnailAssetId?: number;

    // ── Content columns ──────────────────────────────────────────────────────
    @Column({ name: "motion_prompt", type: "text" })
    motionPrompt!: string;

    @Column({ name: "negative_prompt", type: "text", nullable: true })
    negativePrompt?: string;

    // ── Status & external task ───────────────────────────────────────────────
    @Column({ length: 50, default: "pending" })
    status!: string; // pending | queued | processing | delayed | provider_succeeded | uploading | upload_failed | succeeded | provider_failed | failed | cancelled

    @Column({ name: "external_task_id", length: 255, nullable: true })
    externalTaskId?: string;

    @Column({ name: "external_reference_id", length: 255, nullable: true, unique: true })
    externalReferenceId?: string;

    @Column({ name: "next_poll_at", type: "timestamptz", nullable: true })
    nextPollAt?: Date;

    @Column({ name: "last_polled_at", type: "timestamptz", nullable: true })
    lastPolledAt?: Date;

    @Column({ name: "poll_attempts", type: "int", default: 0 })
    pollAttempts!: number;

    @Column({ name: "reconcile_lease_until", type: "timestamptz", nullable: true })
    reconcileLeaseUntil?: Date;

    // ── Video settings ───────────────────────────────────────────────────────
    /** std | pro | 4k | 480p | 720p | 1080p — DB default: 'std' */
    @Column({ name: "generation_mode", length: 20, default: "std" })
    generationMode!: string;

    @Column({ name: "generation_ratio", length: 20, nullable: true })
    generationRatio?: string;

    @Column({ name: "duration_seconds", type: "int", nullable: true })
    durationSeconds?: number;

    @Column({ type: "int", nullable: true })
    fps?: number;

    @Column({ name: "generation_sound", type: "boolean", default: false })
    generationSound!: boolean;

    // ── Payload / metadata ───────────────────────────────────────────────────
    @Column({ type: "jsonb", default: "{}" })
    params!: object;

    @Column({ name: "request_payload", type: "jsonb", default: "{}" })
    requestPayload!: object;

    @Column({ name: "response_payload", type: "jsonb", default: "{}" })
    responsePayload!: object;

    @Column({ name: "result_payload", type: "jsonb", default: "{}" })
    resultPayload!: object;

    // ── Error ────────────────────────────────────────────────────────────────
    @Column({ name: "error_message", type: "text", nullable: true })
    errorMessage?: string;

    // ── Cost & timing ────────────────────────────────────────────────────────
    @Column({ type: "bigint", nullable: true })
    cost?: number;

    @Column({ name: "started_at", type: "timestamptz", nullable: true })
    startedAt?: Date;

    @Column({ name: "completed_at", type: "timestamptz", nullable: true })
    completedAt?: Date;

    @CreateDateColumn({ name: "created_at", type: "timestamptz", default: () => "now()" })
    createdAt!: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamptz", default: () => "now()" })
    updatedAt!: Date;

    // ── Relations ────────────────────────────────────────────────────────────
    @ManyToOne(() => Projects, { nullable: true })
    @JoinColumn({ name: "project_id" })
    project?: Projects;

    @ManyToOne(() => Opportunities, { nullable: true })
    @JoinColumn({ name: "opportunity_id" })
    opportunity?: Opportunities;

    @ManyToOne(() => Tasks, { nullable: true })
    @JoinColumn({ name: "task_id" })
    task?: Tasks;

    @ManyToOne(() => AiModels)
    @JoinColumn({ name: "model_id" })
    model!: AiModels;

    @ManyToOne(() => Accounts)
    @JoinColumn({ name: "user_id" })
    user!: Accounts;

    @ManyToOne(() => Assets)
    @JoinColumn({ name: "image_begin_asset_id" })
    imageBeginAsset?: Assets;

    @ManyToOne(() => Assets)
    @JoinColumn({ name: "image_end_asset_id" })
    imageEndAsset?: Assets;

    @ManyToOne(() => Assets)
    @JoinColumn({ name: "output_asset_id" })
    outputAsset?: Assets;

    @ManyToOne(() => Assets)
    @JoinColumn({ name: "thumbnail_asset_id" })
    thumbnailAsset?: Assets;
}
