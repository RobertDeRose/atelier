import type { AtelierCore } from "../../../packages/core/src/index.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validationPlanningInstruction(core: AtelierCore): string {
  let entries: Array<{
    name: string;
    category: "focused" | "full";
    required: boolean;
    paths: string[];
    symbols: string[];
  }>;
  try {
    entries = Object.entries(core.validation.manifest().validations)
      .map(([name, definition]) => ({
        name,
        category: definition.category === "full" ? "full" as const : "focused" as const,
        required: definition.required === true,
        paths: [...(definition.paths ?? [])].sort(),
        symbols: [...(definition.symbols ?? [])].sort(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    return `The configured validation catalog could not be read: ${errorMessage(error)}. Do not invent validation names; leave execution.validations empty and report the configuration problem in the plan.`;
  }
  if (entries.length === 0) {
    return "No validations are configured. Set execution.validations to [] and do not invent package-script or tool names.";
  }
  return "Use only exact names from this configured validation catalog: "
    + `${JSON.stringify(entries)}. `
    + "For each task, execution.validations must include every required focused validation whose configured paths or symbols match the task scope. "
    + "Do not substitute an unconfigured command such as typecheck, test, or check. Keep the human-readable Validation and Completion criteria sections consistent with the exact execution.validations array.";
}

export function planInstruction(core: AtelierCore, objective: string): string {
  return `[Atelier PLAN MODE]\n\n` +
    `Investigate the repository without modifying source code, dependencies, repository state, or task-provider state. ` +
    `Write or update the implementation plan only at ${core.config.planPath}. ` +
    "Read exact repository paths named by the objective directly; do not force semantic discovery for known files or trivial local edits. When the objective names every implementation and test path and does not request broader impact analysis, read only those named paths and the existing plan—do not inspect package manifests or start provider search. When an implementation location is unknown, reuse current scoped inventory with atlr_code_status or call atlr_code_search once, then inspect the compact inventory before another request. " +
    "Use atlr_code_symbols only for unresolved identifiers during autonomous discovery, and use built-in read for known or returned paths. " +
    "Prefer provider evidence before broad rg, grep, find, fd, tree, or ls discovery, but use exact raw inspection when provider evidence is insufficient or the request requires it. " +
    "Use the smallest independently deliverable task graph: keep tests and implementation together unless they can be completed and accepted separately. Use stable task IDs, explicit dependencies, scope, validation steps, observable completion criteria, and an exact execution object in each atlr:task metadata comment naming every reviewed writable repository-relative path, declared validation, dependency-change constraint, full-suite constraint, and local-change constraint. Format each metadata comment as a readable multiline block with `<!-- atlr:task` on its own line, indented JSON on following lines, and `-->` on its own line; never compress reviewed task authority into one long line. " +
    `${validationPlanningInstruction(core)} ` +
    "Do not ask the user to describe textual plan edits after the draft; Atelier will open the plan in their configured editor. " +
    `When the draft is complete, stop.\n\nObjective: ${objective || "Create an implementation plan for the current request."}`;
}
