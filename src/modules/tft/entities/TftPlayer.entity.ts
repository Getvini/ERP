import { Entity, Column, Index } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";

/** Thống kê cá nhân của Vini Tactics (PvE). */
@Entity()
@Index(["accountId"], { unique: true })
@Index(["bestRound"])
export class TftPlayers extends BaseEntity {
    @Column({ type: "varchar", length: 26 })
    accountId: string;

    @Column({ type: "int", default: 0 })
    runs: number;

    @Column({ type: "int", default: 0 })
    cleared: number;        // số lần vượt hết các vòng

    @Column({ type: "int", default: 0 })
    bestRound: number;      // vòng xa nhất từng đạt (vượt hết = totalRounds + 1)

    @Column({ type: "int", default: 0 })
    battleWins: number;
}
