import type { ApprovedTaskConstraint } from "../domain/types.ts";
import { repositoryRelativePath } from "../repository/repository-path.ts";

function displayPath(repositoryRoot: string, path: string): string {
  try {
    return repositoryRelativePath(repositoryRoot, path, "write");
  } catch {
    return path;
  }
}

/** Human-facing reviewed task constraints. This is not a permission profile. */
export function taskConstraintSummary(
  constraints: ApprovedTaskConstraint[],
  repositoryRoot: string,
): string[] {
  const lines: string[] = [];
  for (const constraint of constraints) {
    lines.push(`Reviewed task constraints for ${constraint.planTaskId}:`);
    lines.push(`  Expected writes: ${constraint.writePaths.map((path) => displayPath(repositoryRoot, path)).join(", ") || "none"}`);
    lines.push(`  Dependency changes: ${constraint.allowDependencyChanges ? `expected only for ${constraint.dependencyPaths.map((path) => displayPath(repositoryRoot, path)).join(", ") || "reviewed manifests"}` : "excluded"}`);
    lines.push(`  Focused validations: ${constraint.focusedValidations.join(", ") || "none"}`);
    lines.push(`  Full suite: ${constraint.allowFullSuite ? constraint.fullValidations.join(", ") || "expected" : "excluded"}`);
    lines.push(`  Local change: ${constraint.allowLocalChange ? "expected for reviewed paths" : "excluded"}`);
    lines.push("  Filesystem approval is decided separately from concrete workspace effects and recoverability.");
  }
  return lines;
}
