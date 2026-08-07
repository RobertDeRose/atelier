import type { AtelierCore } from "../../../packages/core/src/index.ts";

function qualityGatePlanningInstruction(): string {
  return "Do not ask the user to name an abstract validation or invent a command. "
    + "For new tasks, leave the compatibility execution.validations array empty; Atelier discovers the repository quality-gate profile, tool identity, path coverage, and proposals during approval. "
    + "Describe the discovered repository checks in user language in the Validation and Completion criteria sections, without naming internal validation definitions. "
    + "Keep any legacy validation names unchanged only when editing an existing historical task.";
}

export function planInstruction(core: AtelierCore, objective: string): string {
  return `[Atelier PLAN MODE]\n\n` +
    `Investigate the repository without modifying source code, dependencies, repository state, or task-provider state. ` +
    `Write or update the implementation plan only at ${core.config.planPath}. ` +
    "Read exact repository paths named by the objective directly; do not force semantic discovery for known files or trivial local edits. When the objective names every implementation and test path and does not request broader impact analysis, read only those named paths and the existing plan—do not inspect package manifests or start provider search. When an implementation location is unknown, reuse current scoped inventory with atlr_code_status or call atlr_code_search once, then inspect the compact inventory before another request. " +
    "Use atlr_code_symbols only for unresolved identifiers during autonomous discovery, and use built-in read for known or returned paths. " +
    "Prefer provider evidence before broad rg, grep, find, fd, tree, or ls discovery, but use exact raw inspection when provider evidence is insufficient or the request requires it. " +
    "Use the smallest independently deliverable task graph: keep tests and implementation together unless they can be completed and accepted separately. Use stable task IDs, explicit dependencies, scope, repository quality-gate coverage, observable completion criteria, and an exact execution object in each atlr:task metadata comment naming every reviewed writable repository-relative path, compatibility validation array, dependency-change constraint, full-suite constraint, and local-change constraint. Format each metadata comment as a readable multiline block with `<!-- atlr:task` on its own line, indented JSON on following lines, and `-->` on its own line; never compress reviewed task authority into one long line. " +
    `${qualityGatePlanningInstruction()} ` +
    "Do not ask the user to describe textual plan edits after the draft; Atelier will open the plan in their configured editor. " +
    `When the draft is complete, stop.\n\nObjective: ${objective || "Create an implementation plan for the current request."}`;
}
