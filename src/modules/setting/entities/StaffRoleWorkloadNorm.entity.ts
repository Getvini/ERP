import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";
import { STAFF_ROLES, UserRole } from "../../account/entities/Account.entity";

@Entity({ name: "staff_role_workload_norms" })
export class StaffRoleWorkloadNorms {
    @PrimaryColumn({
        type: "enum",
        enum: STAFF_ROLES
    })
    role!: UserRole;

    @Column({ name: "monthly_norm", type: "decimal", precision: 15, scale: 3, default: 22000 })
    monthlyNorm!: number;

    @Column({ name: "updated_by_id", type: "varchar", length: 26, nullable: true })
    updatedById!: string | null;

    @CreateDateColumn({ name: "created_at", type: "timestamptz", default: () => "now()" })
    createdAt!: Date;

    @UpdateDateColumn({ name: "updated_at", type: "timestamptz", default: () => "now()" })
    updatedAt!: Date;
}
