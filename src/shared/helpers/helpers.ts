import * as jwt from "jsonwebtoken";
import { SignOptions } from "jsonwebtoken";
import * as bcrypt from "bcrypt";
import * as dotenv from "dotenv";
import { createHash } from "crypto";

dotenv.config();
const ACCESS_TOKEN_SECRET = process.env.JWT_SECRET || "";
const REFRESH_TOKEN_SECRET = process.env.JWT_SECRET || "";

export interface RefreshTokenPayload extends jwt.JwtPayload {
    id: string;
    sessionId: string;
    type: "refresh";
}
export class encrypt {
    static async encryptPassword(password: string) {
        return bcrypt.hashSync(password, 12);
    }
    static comparePassword(password: string, hashPassword: string) {
        return bcrypt.compareSync(password, hashPassword);
    }

    static generateAccessToken(payload: { id: string; role: string }, expiresIn: SignOptions["expiresIn"] = "4h") {
        return jwt.sign({ ...payload, type: "access" }, ACCESS_TOKEN_SECRET, { expiresIn });
    }

    static generateRefreshToken(
        payload: { id: string; sessionId: string },
        expiresIn: SignOptions["expiresIn"] = "1d"
    ) {
        return jwt.sign({ ...payload, type: "refresh" }, REFRESH_TOKEN_SECRET, { expiresIn });
    }

    static verifyRefreshToken(token: string, ignoreExpiration = false): RefreshTokenPayload {
        return jwt.verify(token, REFRESH_TOKEN_SECRET, { ignoreExpiration }) as RefreshTokenPayload;
    }

    static hashToken(token: string) {
        return createHash("sha256").update(token).digest("hex");
    }
}

const ENCRYPTION_SECRET = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || "getvini-erp-aes-key-secret-32b!";
const AES_KEY = createHash("sha256").update(ENCRYPTION_SECRET).digest();

export class CryptoHelper {
    static encryptAES(text: string | null | undefined): string | null {
        if (!text) return null;
        const clean = String(text).trim();
        if (!clean) return null;
        if (clean.startsWith("enc:")) return clean;

        const { randomBytes, createCipheriv } = require("crypto");
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", AES_KEY, iv);
        let encrypted = cipher.update(clean, "utf8", "hex");
        encrypted += cipher.final("hex");
        const authTag = cipher.getAuthTag().toString("hex");
        return `enc:${iv.toString("hex")}:${authTag}:${encrypted}`;
    }

    static decryptAES(cipherText: string | null | undefined): string | null {
        if (!cipherText) return null;
        const clean = String(cipherText).trim();
        if (!clean) return null;
        if (!clean.startsWith("enc:")) return clean;

        try {
            const parts = clean.split(":");
            if (parts.length !== 4) return clean;
            const { createDecipheriv } = require("crypto");
            const iv = Buffer.from(parts[1], "hex");
            const authTag = Buffer.from(parts[2], "hex");
            const encryptedText = parts[3];
            const decipher = createDecipheriv("aes-256-gcm", AES_KEY, iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(encryptedText, "hex", "utf8");
            decrypted += decipher.final("utf8");
            return decrypted;
        } catch {
            return clean;
        }
    }
}

