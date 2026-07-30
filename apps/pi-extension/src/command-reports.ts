import type {
  AtelierStatus,
  CodeProviderStatus,
  RetrievalSessionStatus,
  ValidationEvidenceSummary,
} from "../../../packages/core/src/index.ts";
import { createStatusView } from "../../../packages/core/src/index.ts";
import { code, markdownTable } from "./report-presentation.ts";

export function statusMarkdown(status: AtelierStatus): string {
  const view = createStatusView(status);
  return [
    "## Atelier status",
    "",
    markdownTable([
      ["workspace", `${code(view.workspace.root)} (${view.workspace.source.replaceAll("_", " ")})`],
      ["repository", `${code(view.repository.identity)} · ${view.repository.provider} · dirty generation ${view.repository.dirtyGeneration}`],
      ["mode", code(view.workflow.mode)],
      ["plan", view.workflow.plan],
      ["task", view.task.current === "none" ? "none" : code(view.task.current)],
      ["execution", view.execution.grant === "none" ? "none" : code(view.execution.grant)],
      ["task provider", `${view.task.provider} (${view.task.providerState})`],
      ["closure", view.execution.closure],
    ]),
    "",
    ...(view.workflow.objective === undefined ? [] : ["### Objective", "", view.workflow.objective, ""]),
    "### Next action",
    "",
    view.workflow.nextAction,
  ].join("\n");
}

export function codeStatusMarkdown(status: CodeProviderStatus, retrieval: RetrievalSessionStatus): string {
  const providerState = status.identity.name === "disabled" || status.detail?.includes("disabled")
    ? "disabled"
    : !status.available || !status.healthy || status.indexState === "failed"
      ? "offline"
      : status.degraded === true || status.indexState === "stale"
        ? "degraded"
        : status.indexState === "building"
          ? "indexing"
          : "ready";
  return [
    "## Code intelligence",
    "",
    markdownTable([
      ["provider", status.identity.name],
      ["state", providerState],
      ["available", String(status.available)],
      ["healthy", String(status.healthy)],
      ["index", status.indexState],
      ["retrieval freshness", retrieval.inventory.freshness],
      ["remaining requests", String(Math.max(0, retrieval.budget.providerRequestsLimit - retrieval.budget.providerRequestsUsed))],
    ]),
    "",
    ...(status.detail === undefined ? [] : ["### Detail", "", status.detail.split(/\r?\n/)[0] ?? status.detail, ""]),
    "### Capabilities",
    "",
    status.capabilities.length === 0 ? "- none" : status.capabilities.map((capability) => `- ${code(capability)}`).join("\n"),
  ].join("\n");
}

export function changedMarkdown(paths: string[], vcs: string): string {
  return [
    "## Changed paths",
    "",
    `Repository provider: ${code(vcs)}`,
    "",
    ...(paths.length === 0 ? ["No changed paths."] : paths.map((path) => `- ${code(path)}`)),
  ].join("\n");
}

export function validationListMarkdown(validations: Record<string, { command: string[]; required?: boolean; focused?: boolean }>): string {
  const entries = Object.entries(validations);
  return [
    "## Configured validations",
    "",
    ...(entries.length === 0
      ? ["No validations configured."]
      : entries.flatMap(([name, value]) => [
          `### ${code(name)}`,
          "",
          `- command: ${code(value.command.join(" "))}`,
          `- required: ${value.required === true ? "yes" : "no"}`,
          `- focused: ${value.focused === true ? "yes" : "no"}`,
          "",
        ])),
  ].join("\n");
}

export function focusedSelectionMarkdown(selection: {
  id: string;
  noMatch: boolean;
  selected: Array<{ name: string; reason: string; required: boolean }>;
}): string {
  return [
    "## Focused validation plan",
    "",
    `Selection: ${code(selection.id)}`,
    "",
    ...(selection.noMatch || selection.selected.length === 0
      ? ["No configured validations matched the current changes."]
      : selection.selected.map((item) => `- **${item.name}**${item.required ? " — required" : ""}\n  ${item.reason}`)),
  ].join("\n");
}

export function validationResultsMarkdown(results: Array<{ name: string; status: string; durationMs: number }>): string {
  return [
    "## Validation results",
    "",
    ...(results.length === 0
      ? ["No focused validations matched."]
      : results.map((item) => `- **${item.name}:** ${item.status} (${item.durationMs} ms)`)),
  ].join("\n");
}

export function evidenceMarkdown(items: ValidationEvidenceSummary[]): string {
  return [
    "## Validation evidence",
    "",
    ...(items.length === 0
      ? ["No validation evidence."]
      : items.map((item) => `- **${item.name}:** ${item.status} · ${item.stale ? "stale" : "current"}`)),
  ].join("\n");
}

export function readyTasksMarkdown(tasks: Array<{ id: string; title: string; priority: number; status?: string }>): string {
  return [
    "## Ready tasks",
    "",
    ...(tasks.length === 0
      ? ["No ready task is available."]
      : [
          "| task | priority | title | status |",
          "|---|---:|---|---|",
          ...tasks.map((task) => `| ${code(task.id)} | ${task.priority} | ${task.title.replaceAll("|", "\\|")} | ${task.status ?? "ready"} |`),
        ]),
  ].join("\n");
}
