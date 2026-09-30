import { Entity, Column, Index } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";

/** Một lượt chơi. state chỉ được lưu ở đầu mỗi vòng (và khi rời) để khôi phục sau khi tải lại/restart. */
@Entity()
@Index(["accountId", "status"])
export class TftRuns extends BaseEntity {
    @Column({ type: "varchar", length: 26 })
    accountId: string;

    @Column({ type: "varchar", length: 64 })
    seed: string;

    /** shop | won | lost | abandoned */
    @Column({ type: "varchar", length: 16, default: "shop" })
    status: string;

    @Column({ type: "int", default: 1 })
    round: number;

    @Column({ type: "int", default: 0 })
    wins: number;

    @Column({ type: "simple-json", nullable: true })
    state: any;

    @Column({ type: "timestamp", nullable: true })
    endedAt: Date | null;
}
