import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const JWT_SECRET = process.env["SESSION_SECRET"] ?? "card-scanner-pro-secret";

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function comparePassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function signToken(payload: { id: number; email: string; role: string; companyId: number | null }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): { id: number; email: string; role: string; companyId: number | null } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { id: number; email: string; role: string; companyId: number | null };
  } catch {
    return null;
  }
}
