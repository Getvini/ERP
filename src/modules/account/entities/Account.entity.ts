import { Entity, Column, Index, JoinColumn, ManyToOne } from "typeorm";
import { BaseEntity } from "../../../shared/entities/BaseEntity";
import { Users } from "../../user/entities/User.entity";

export enum UserRole {
    BOD = "BOD",
    ADMIN = "ADMIN",
    ADMIN_SALE = "ADMIN_SALE",
    BD = "BD",
    PM = "PM",
    CONTENT_A = "CONTENT_A",
    CONTENT_B = "CONTENT_B",
    CONTENT_C = "CONTENT_C",
    CONTENT_D = "CONTENT_D",
    EDITOR_A = "EDITOR_A",
    EDITOR_B = "EDITOR_B",
    EDITOR_C = "EDITOR_C",
    EDITOR_D = "EDITOR_D",
    DESIGNER_A = "DESIGNER_A",
    DESIGNER_B = "DESIGNER_B",
    DESIGNER_C = "DESIGNER_C",
    DESIGNER_D = "DESIGNER_D",
    STAFF_A = "STAFF_A",
    STAFF_B = "STAFF_B",
    STAFF_C = "STAFF_C",
    STAFF_D = "STAFF_D",
}

export const STAFF_ROLES = [
    UserRole.CONTENT_A,
    UserRole.CONTENT_B,
    UserRole.CONTENT_C,
    UserRole.CONTENT_D,
    UserRole.EDITOR_A,
    UserRole.EDITOR_B,
    UserRole.EDITOR_C,
    UserRole.EDITOR_D,
    UserRole.DESIGNER_A,
    UserRole.DESIGNER_B,
    UserRole.DESIGNER_C,
    UserRole.DESIGNER_D,
    UserRole.STAFF_A,
    UserRole.STAFF_B,
    UserRole.STAFF_C,
    UserRole.STAFF_D,
];

export const MANAGEMENT_ROLES = [
    UserRole.BOD,
    UserRole.ADMIN,
];

export const SALES_ROLES = [
    UserRole.BD,
    UserRole.ADMIN_SALE,
];

export const PROJECT_MANAGEMENT_ROLES = [
    UserRole.BOD,
    UserRole.ADMIN,
    UserRole.PM,
];

export const isStaffRole = (role?: string): role is UserRole => STAFF_ROLES.includes(role as UserRole);
export const isManagementRole = (role?: string): role is UserRole => MANAGEMENT_ROLES.includes(role as UserRole);
export const isProjectManagementRole = (role?: string): role is UserRole => PROJECT_MANAGEMENT_ROLES.includes(role as UserRole);

@Entity()
@Index(["username"], { unique: true })
@Index(["email"], { unique: true })
export class Accounts extends BaseEntity {

    @Column()
    username: string;

    @Column()
    password: string;

    @Column({ nullable: true })
    email: string;

    @Column({
        type: "enum",
        enum: UserRole,
        default: UserRole.EDITOR_D
    })
    role: UserRole;

    @Column({ default: true })
    isActive: boolean;

    @Column({ default: 0 })
    vinicoin: number;

    @Column({ default: 0 })
    vinicoinTotal: number;

    @Column({ default: 0 })
    vinicoinWithdrawn: number;

    @ManyToOne(() => Users, (user) => user.accounts, { onDelete: "CASCADE" })
    @JoinColumn({ name: "userId" })
    user: Users;

    @Column({ type: "varchar", length: 26, nullable: true })
    userId: string;

}
