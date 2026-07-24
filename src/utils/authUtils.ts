import jwt from "jsonwebtoken";
import { UserRole } from "@/types/user";

const JWT_SECRET = process.env.JWT_SECRET!;

export interface JwtPayload {
  istid: string;
  roles: UserRole[];
  name: string;
  email: string;
}

export function signUserJWT(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "1d" });
}

export function getUserFromJWT(token: string | undefined): JwtPayload | null {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

export function decodeJWTPayload(token: string | undefined): JwtPayload | null {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) {
      base64 += "=";
    }
    const payload = JSON.parse(atob(base64));
    return payload as JwtPayload;
  } catch {
    return null;
  }
}
