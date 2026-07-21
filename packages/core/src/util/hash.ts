import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashFile(path: string): string {
  return sha256(readFileSync(path));
}
