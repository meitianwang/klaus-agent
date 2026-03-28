import { randomBytes } from "node:crypto";

export function generateId(): string {
  return randomBytes(9).toString("base64url").slice(0, 12);
}
