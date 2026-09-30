import { Entity, Column, Index } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";

/** status: active | finished | aborted — result: red | black | draw | null */
@Entity()
@Index(["redAccountId"])
@Index(["blackAccountId"])
@Index(["status"])
export class XiangqiGames extends BaseEntity {
    @Column({ type: "varchar", length: 26 })
    redAccountId: string;

    @Column({ type: "varchar", length: 26 })
    blackAccountId: string;

    @Column({ type: "int" })
    redRatingBefore: number;

    @Column({ type: "int" })
    blackRatingBefore: number;

    @Column({ type: "int", nullable: true })
    redRatingAfter: number | null;

    @Column({ type: "int", nullable: true })
    blackRatingAfter: number | null;

    @Column({ type: "int", default: 600 })
    timeControl: number;

    @Column({ type: "varchar", length: 16, default: "active" })
    status: string;

    @Column({ type: "varchar", length: 16, nullable: true })
    result: string | null;

    @Column({ type: "varchar", length: 32, nullable: true })
    reason: string | null;

    @Column({ type: "simple-json", nullable: true })
    moves: { fr: number; fc: number; tr: number; tc: number }[] | null;

    @Column({ type: "timestamp", nullable: true })
    endedAt: Date | null;
}
