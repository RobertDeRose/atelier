import { resolveAccessPath } from "../security/path-boundary.ts";

export interface SessionWorkspace {
  root: string;
  source: "startup_cwd" | "explicit";
}

export function establishSessionWorkspace(startupCwd: string, explicitRoot?: string): SessionWorkspace {
  const selected = explicitRoot ?? startupCwd;
  return {
    root: resolveAccessPath(selected, "read", startupCwd),
    source: explicitRoot === undefined ? "startup_cwd" : "explicit",
  };
}
