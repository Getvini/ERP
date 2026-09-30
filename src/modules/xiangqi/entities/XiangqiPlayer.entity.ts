import { Entity, Column, Index } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";

@Entity()
@Index(["accountId"], { unique: true })
@Index(["rating"])
export class XiangqiPlayers extends BaseEntity {
    @Column({ type: "varchar", length: 26 })
    accountId: string;

    @Column({ type: "int", default: 1200 })
    rating: number;

    @Column({ type: "int", default: 0 })
    gamesPlayed: number;

    @Column({ type: "int", default: 0 })
    wins: number;

    @Column({ type: "int", default: 0 })
    losses: number;

    @Column({ type: "int", default: 0 })
    draws: number;
}
