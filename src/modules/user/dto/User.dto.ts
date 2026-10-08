import { IsString, IsNotEmpty, IsOptional, IsEmail, IsEnum, IsBoolean, IsDateString, IsArray, Matches, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { UserRole } from "../../account/entities/Account.entity";

export class IdCardDTO {
    @IsString()
    @IsOptional()
    frontUrl?: string;

    @IsString()
    @IsOptional()
    backUrl?: string;

    @IsString()
    @Matches(/^([0-9]{9}|[0-9]{12})$/, { message: "Số CCCD / CMND phải gồm đúng 9 hoặc 12 chữ số" })
    @IsOptional()
    idNumber?: string;
}

export class CreateUserDTO {
    @IsString()
    @IsNotEmpty({ message: "Username không được để trống" })
    username: string;

    @IsString()
    @IsNotEmpty({ message: "Password không được để trống" })
    password: string;

    @IsString()
    @IsNotEmpty({ message: "Họ tên không được để trống" })
    fullName: string;

    @IsString()
    @IsOptional()
    phoneNumber?: string;

    @IsDateString({}, { message: "Ngày sinh không hợp lệ" })
    @IsOptional()
    birthday?: string;

    @IsBoolean()
    @IsOptional()
    isLocked?: boolean;

    @IsEnum(UserRole)
    @IsNotEmpty({ message: "Role không được để trống" })
    role: UserRole;
}

export class UpdateUserDTO {
    @IsString()
    @IsOptional()
    fullName?: string;

    @IsEmail({}, { message: "Email không hợp lệ" })
    @IsOptional()
    email?: string;

    @IsString()
    @IsOptional()
    phoneNumber?: string;

    @IsDateString({}, { message: "Ngày sinh không hợp lệ" })
    @IsOptional()
    birthday?: string;

    @IsEnum(UserRole)
    @IsOptional()
    role?: UserRole;

    @IsBoolean()
    @IsOptional()
    isActive?: boolean;

    @IsBoolean()
    @IsOptional()
    isLocked?: boolean;

    @IsString()
    @IsOptional()
    avatarUrl?: string;

    @IsString()
    @IsOptional()
    portfolioUrl?: string;

    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    hobbies?: string[];

    @ValidateNested()
    @Type(() => IdCardDTO)
    @IsOptional()
    idCard?: IdCardDTO | null;
}
