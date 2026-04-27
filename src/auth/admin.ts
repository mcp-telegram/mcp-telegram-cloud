import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/** Constant-time comparison of admin Bearer token to prevent timing attacks. */
export function isAdminAuthorized(authHeader: string | undefined): boolean {
  if (!config.adminToken || !authHeader) return false;
  const expected = `Bearer ${config.adminToken}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
