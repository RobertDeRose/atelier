import { relative } from "node:path";
import type { ExecutionCapability } from "../domain/types.ts";

function displayPath(repositoryRoot: string, path: string): string {
  const value = relative(repositoryRoot, path).replaceAll("\\", "/");
  return value || ".";
}

export function executionCapabilitySummary(
  capabilities: ExecutionCapability[],
  repositoryRoot: string,
): string[] {
  const taskIds = [...new Set(capabilities.map((item) => item.planTaskId))];
  const lines: string[] = [];
  for (const taskId of taskIds) {
    const taskCapabilities = capabilities.filter((item) => item.planTaskId === taskId);
    const write = taskCapabilities.find((item) => item.permission === "file.write");
    const dependency = taskCapabilities.find((item) => item.permission === "dependency.modify");
    const commit = taskCapabilities.find((item) => item.permission === "repository.change.create");
    const focused = taskCapabilities.find((item) => item.permission === "validation.focused");
    const full = taskCapabilities.some((item) => item.permission === "validation.full_suite");
    lines.push(`Capabilities for ${taskId}:`);
    lines.push(`  Writes: ${write?.paths?.map((path) => displayPath(repositoryRoot, path)).join(", ") || "none"}`);
    lines.push(`  Dependencies: ${dependency === undefined ? "not permitted" : `permitted only for ${dependency.paths?.map((path) => displayPath(repositoryRoot, path)).join(", ") || "reviewed manifests"}`}`);
    lines.push(`  Focused validations: ${focused?.validationNames?.join(", ") || "none"}`);
    lines.push(`  Full suite: ${full ? "permitted" : "not permitted"}`);
    lines.push(`  Local change: ${commit === undefined ? "not permitted" : `permitted for ${commit.paths?.map((path) => displayPath(repositoryRoot, path)).join(", ") || "reviewed paths"}`}`);
    lines.push("  Task operations: close active task after the completion predicate passes");
    lines.push("  Generic shell, publication, external effects, and out-of-scope paths: not permitted");
  }
  return lines;
}
