export type AtelierAgentMode = "plan" | "investigate" | "act";

export interface AtelierAgentProtocolOptions {
  mode: AtelierAgentMode;
  codeIntelligence: "enabled" | "disabled";
}

/**
 * Compact model-facing operating procedure. Keep this explicit: tool metadata
 * is easy for models to overlook, while the protocol is present on every turn.
 */
export function atelierAgentProtocol(options: AtelierAgentProtocolOptions): string {
  const retrieval = options.codeIntelligence === "disabled"
    ? "Code intelligence is disabled; use built-in read for known files and bounded grep/find only when exact raw inspection is necessary."
    : [
        "Provider-first retrieval is the default: for an unknown location or cross-file concept call atlr_code_search once with a narrow semantic query.",
        "Use focus=source for implementation, focus=tests for verification, or focus=docs for documentation; do not paste an entire task description as the query.",
        "Inspect the returned inventory and read returned paths directly; do not issue another search just to open a known file.",
        "Call atlr_code_status when the inventory or provider health is unclear.",
        "Call atlr_code_symbols only for an identifier listed as unresolved after semantic discovery.",
        "Raw repository inspection remains available only when provider evidence is unavailable, stale, empty, or insufficient for the user's exact question.",
      ].join(" ");

  const mode = options.mode === "plan"
    ? "Plan mode: modify only the reviewed plan document; do not mutate source, dependencies, Beads, or VCS state."
    : options.mode === "investigate"
      ? "Investigate only: do not mutate source, dependencies, Beads, or VCS state."
      : "Act mode: modify only the selected task and its reviewed constraints; use typed validation, local-change, and closure tools for those workflow actions.";

  return [
    "## Atelier operating protocol",
    "Atelier is the workflow harness, not just a permission layer.",
    "Treat the injected Atelier Working State as authoritative for the active Beads task, dependencies, execution grant, Jujutsu/Git state, retrieval evidence, validation, and next action.",
    "If that state is missing or unclear, call atlr_state. Do not infer it from conversation history or use raw bd, jj, or git commands for routine state inspection.",
    `Retrieval: ${retrieval}`,
    "Workflow: use read/edit/write for repository content; use atlr_validate for declared checks, atlr_commit for the approved local change, and atlr_task_close only after the completion predicate is satisfied.",
    mode,
  ].join("\n");
}
