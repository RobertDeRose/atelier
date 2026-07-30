import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface SessionWorkspace {
  root: string;
  source: "startup_cwd" | "explicit";
}

export function establishSessionWorkspace(startupCwd: string, explicitRoot?: string): SessionWorkspace {
  const selected = resolve(explicitRoot ?? startupCwd);
  const root = existsSync(selected) ? realpathSync.native(selected) : selected;
  return { root, source: explicitRoot === undefined ? "startup_cwd" : "explicit" };
}
