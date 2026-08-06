import type { AtelierCore } from "../../../packages/core/src/index.ts";
import type {
  AtelierStatus,
  CodeProviderStatus,
  RetrievalSessionStatus,
  ValidationEvidenceSummary,
  WorkingState,
} from "../../../packages/core/src/index.ts";
import { createStatusView } from "../../../packages/core/src/index.ts";
import { code, markdownFields } from "./report-presentation.ts";

function repositoryState(status: AtelierStatus): string {
  return status.repositoryDisplay?.state ?? "unknown";
}

export function statusSummary(status: AtelierStatus): string {
  const view = createStatusView(status);
  const task = status.currentTaskTitle ?? status.currentTaskId;
  return [
    view.workflow.mode,
    `plan ${view.workflow.plan}`,
    ...(task === undefined ? [] : [`task ${task}`]),
    `${view.repository.provider} ${repositoryState(status)}`,
  ].join(" · ");
}

export function statusMarkdown(status: AtelierStatus): string {
  const view = createStatusView(status);
  return [
    markdownFields([
      ["workspace", `${code(view.workspace.root)} (${view.workspace.source.replaceAll("_", " ")})`],
      ["repository", `${code(view.repository.identity)} · ${view.repository.provider} · ${repositoryState(status)}`],
      ["mode", code(view.workflow.mode)],
      ["plan", view.workflow.plan],
      ["task", status.currentTaskTitle ?? (view.task.current === "none" ? "none" : code(view.task.current))],
      ["execution", view.execution.grant === "none" ? "none" : code(view.execution.grant)],
      ["task provider", `${view.task.provider} (${view.task.providerState})`],
      ["closure", view.execution.closure],
    ]),
    ...(view.workflow.objective === undefined ? [] : ["", "### Objective", "", view.workflow.objective]),
    "",
    "### Next action",
    "",
    view.workflow.nextAction,
  ].join("\n");
}

export function workflowStatusMarkdown(status: AtelierStatus): string {
  const view = createStatusView(status);
  const task = status.currentTaskTitle
    ?? (view.task.current === "none" ? "none" : code(view.task.current));
  const execution = status.activeExecutionGrant === undefined
    ? "none"
    : `${code(status.activeExecutionGrant.id)} · ${status.activeExecutionGrant.status} · task ${code(status.activeExecutionGrant.taskId)}`;
  const lines = [
    markdownFields([
      ["mode", code(view.workflow.mode)],
      ["checkpoint", view.workflow.checkpoint],
      ["plan", view.workflow.plan],
      ["task", task],
      ["execution", execution],
      ["task provider", `${view.task.provider} (${view.task.providerState})`],
      ["closure", view.execution.closure],
    ]),
  ];
  if (view.workflow.objective !== undefined) {
    lines.push("", "### Objective", "", view.workflow.objective);
  }
  if (status.activeTaskConstraints.length > 0) {
    lines.push("", "### Reviewed constraints", "");
    for (const constraint of status.activeTaskConstraints) {
      lines.push(
        `- **task:** ${code(constraint.planTaskId)}`,
        `  **writes:** ${constraint.writePaths.length === 0 ? "none" : constraint.writePaths.map(code).join(", ")}`,
        `  **validations:** ${constraint.focusedValidations.length === 0 ? "none" : constraint.focusedValidations.map(code).join(", ")}`,
        `  **local change:** ${constraint.allowLocalChange ? "allowed" : "not allowed"}`,
      );
    }
  }
  lines.push("", "### Next action", "", view.workflow.nextAction);
  return lines.join("\n");
}

function activeTaskLabel(state: WorkingState): string {
  if (state.activeTask === undefined) return "none";
  return `${state.activeTask.title} (${code(state.activeTask.id)})`;
}

function executionLabel(state: WorkingState): string {
  if (state.executionGrant === undefined) return "none";
  return `${code(state.executionGrant.id)} · ${state.executionGrant.status}`;
}

function repositoryLabel(state: WorkingState): string {
  const revision = state.snapshot.vcs === "jj"
    ? state.snapshot.changeId?.slice(0, 8) ?? state.snapshot.headCommit.slice(0, 8)
    : state.snapshot.headCommit.slice(0, 8);
  return `${state.snapshot.vcs} ${code(revision)} · dirty generation ${state.snapshot.dirtyGeneration}`;
}

function closureLabel(state: WorkingState): string {
  if (state.workflowCheckpoint === "completed") return `completed — ${state.taskClosure.reason}`;
  if (state.activeTask === undefined && state.executionGrant === undefined) return "not applicable — no active task";
  return `${state.taskClosure.ready ? "ready" : "blocked"} — ${state.taskClosure.reason}`;
}

export function workflowSummary(state: WorkingState): string {
  const task = state.activeTask?.title ?? state.activeTask?.id;
  return [
    state.mode,
    ...(task === undefined ? ["no active task"] : [task]),
    state.taskClosure.ready ? "ready to close" : state.taskClosure.blockers[0]?.code?.replaceAll("_", " ") ?? "in progress",
  ].join(" · ");
}

export function workflowMarkdown(state: WorkingState): string {
  const lines: string[] = [
    markdownFields([
      ["mode", code(state.mode)],
      ["task", activeTaskLabel(state)],
      ["execution", executionLabel(state)],
      ["checkpoint", state.workflowCheckpoint ?? "none"],
      ["plan approval", state.planApproval === undefined ? "none" : code(state.planApproval.id)],
      ["repository", repositoryLabel(state)],
      ["closure", closureLabel(state)],
      ["next", state.nextAction],
    ]),
  ];

  if (state.planObjective !== undefined) {
    lines.push("", "### Objective", "", state.planObjective);
  }

  if (state.activeTask !== undefined) {
    lines.push(
      "",
      "### Current task",
      "",
      markdownFields([
        ["title", state.activeTask.title],
        ["id", code(state.activeTask.id)],
        ["status", state.activeTask.status],
        ["selection", `${state.taskSelection.source} — ${state.taskSelection.rationale}`],
      ]),
    );
    if (state.activeTask.description) lines.push("", state.activeTask.description);
    if (state.activeTask.acceptanceCriteria.length > 0) {
      lines.push("", "**completion criteria:**", ...state.activeTask.acceptanceCriteria.map((item) => `- ${item}`));
    }
  }

  if (state.taskConstraints.length > 0) {
    lines.push("", "### Reviewed constraints", "");
    for (const constraint of state.taskConstraints) {
      lines.push(
        `- **task:** ${code(constraint.planTaskId)}`,
        `  **writes:** ${constraint.writePaths.length === 0 ? "none" : constraint.writePaths.map(code).join(", ")}`,
        `  **validations:** ${constraint.focusedValidations.length === 0 ? "none" : constraint.focusedValidations.map(code).join(", ")}`,
        `  **local change:** ${constraint.allowLocalChange ? "allowed" : "not allowed"}`,
      );
    }
  }

  const currentValidation = state.currentValidationEvidence.map((item) => `${item.name}: ${item.status}`);
  const staleValidation = state.staleValidationEvidence.map((item) => `${item.name}: stale`);
  if (
    state.executionEvidence.length > 0 ||
    state.focusedValidationSelections.length > 0 ||
    currentValidation.length > 0 ||
    staleValidation.length > 0 ||
    state.finalDiffReview !== undefined
  ) {
    lines.push(
      "",
      "### Progress",
      "",
      markdownFields([
        ["mutating operations", String(state.executionEvidence.length)],
        ["focused validation", state.focusedValidationSelections.at(-1)?.selected.map((item) => item.name).join(", ") || "not selected"],
        ["validation evidence", [...currentValidation, ...staleValidation].join(", ") || "none"],
        ["diff review", state.finalDiffReview === undefined ? "not recorded" : code(state.finalDiffReview.diffHash)],
      ]),
    );
  }

  if (state.executionEvidence.length > 0) {
    lines.push("", "### Recent execution evidence", "");
    for (const item of state.executionEvidence.slice(-5)) {
      lines.push(`- **${item.toolName}:** ${item.status} · changed ${item.changedPaths.length} path(s)`);
    }
  }

  if (state.retrievalSession !== undefined) {
    const session = state.retrievalSession;
    lines.push(
      "",
      "### Retrieval",
      "",
      markdownFields([
        ["freshness", session.freshness],
        ["provider calls", String(session.telemetry.providerCalls)],
        ["cache hits", String(session.telemetry.cacheHits)],
        ["known paths", String(session.knownPaths.length)],
        ["resolved symbols", String(session.resolvedSymbols.length)],
        ["unresolved symbols", session.unresolvedSymbols.join(", ") || "none"],
        ["request budget", `${session.budget.providerRequestsUsed}/${session.budget.providerRequestsLimit}`],
      ]),
    );
  }

  const diagnostics = [
    ...state.taskBlockers.map((item) => `${item.id}: ${item.title}`),
    ...state.omissions,
  ];
  if (diagnostics.length > 0) {
    lines.push("", "### Diagnostics", "", ...diagnostics.slice(0, 8).map((item) => `- ${item}`));
  }

  return lines.join("\n");
}

export function codeStatusState(status: CodeProviderStatus): "disabled" | "offline" | "degraded" | "indexing" | "ready" {
  return status.identity.name === "disabled" || status.detail?.includes("disabled")
    ? "disabled"
    : !status.available || !status.healthy || status.indexState === "failed"
      ? "offline"
      : status.degraded === true || status.indexState === "stale"
        ? "degraded"
        : status.indexState === "building"
          ? "indexing"
          : "ready";
}

export function codeStatusSummary(status: CodeProviderStatus, retrieval: RetrievalSessionStatus): string {
  return `${status.identity.name} · ${codeStatusState(status)}${status.lock === undefined ? "" : ` · lock ${status.lock.state}`} · ${retrieval.inventory.freshness}`;
}

export function codeStatusMarkdown(status: CodeProviderStatus, retrieval: RetrievalSessionStatus): string {
  const providerState = codeStatusState(status);
  return [
    markdownFields([
      ["provider", status.identity.name],
      ["state", providerState],
      ["available", String(status.available)],
      ["healthy", String(status.healthy)],
      ["index", status.indexState],
      ["retrieval freshness", retrieval.inventory.freshness],
      ["remaining requests", String(Math.max(0, retrieval.budget.providerRequestsLimit - retrieval.budget.providerRequestsUsed))],
    ]),
    ...(status.lock === undefined ? [] : [
      "",
      "### Database lock",
      "",
      `- **state:** ${status.lock.state}`,
      `- **database:** ${status.lock.databasePaths.map(code).join(", ")}`,
      ...(status.lock.holders?.map((holder) => `- **holder:** PID ${holder.pid} ${holder.command} · ${holder.paths.map(code).join(", ")}`) ?? []),
      ...(status.lock.detail === undefined ? [] : [`- **detail:** ${status.lock.detail}`]),
    ]),
    ...(status.warnings === undefined || status.warnings.length === 0 ? [] : [
      "",
      "### Warnings",
      "",
      ...status.warnings.map((warning) => `- ${warning}`),
    ]),
    ...(status.detail === undefined ? [] : ["", "### Detail", "", status.detail.split(/\r?\n/)[0] ?? status.detail]),
    "",
    "### Capabilities",
    "",
    status.capabilities.length === 0 ? "- none" : status.capabilities.map((capability) => `- ${code(capability)}`).join("\n"),
  ].join("\n");
}

export function changedMarkdown(paths: string[], vcs: string): string {
  return [
    markdownFields([
      ["repository provider", code(vcs)],
      ["changed paths", String(paths.length)],
    ]),
    "",
    ...(paths.length === 0 ? ["No changed paths."] : paths.map((path) => `- ${code(path)}`)),
  ].join("\n");
}

export function validationListMarkdown(validations: Record<string, { command: string[]; required?: boolean; focused?: boolean }>): string {
  const entries = Object.entries(validations);
  return [
    ...(entries.length === 0
      ? ["No validations configured."]
      : entries.flatMap(([name, value]) => [
          `### ${code(name)}`,
          "",
          markdownFields([
            ["command", code(value.command.join(" "))],
            ["required", value.required === true ? "yes" : "no"],
            ["focused", value.focused === true ? "yes" : "no"],
          ]),
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
    markdownFields([
      ["selection", code(selection.id)],
      ["matched validations", String(selection.selected.length)],
    ]),
    "",
    ...(selection.noMatch || selection.selected.length === 0
      ? ["No configured validations matched the current changes."]
      : selection.selected.map((item) => `- **${item.name}:** ${item.required ? "required · " : ""}${item.reason}`)),
  ].join("\n");
}

export function validationResultsMarkdown(results: Array<{ name: string; status: string; durationMs: number }>): string {
  return [
    ...(results.length === 0
      ? ["No focused validations matched."]
      : results.map((item) => `- **${item.name}:** ${item.status} (${item.durationMs} ms)`)),
  ].join("\n");
}

export function evidenceMarkdown(items: ValidationEvidenceSummary[]): string {
  return [
    ...(items.length === 0
      ? ["No validation evidence."]
      : items.map((item) => `- **${item.name}:** ${item.status} · ${item.historical ? "historical compatibility" : item.stale ? "stale" : "current"}`)),
  ].join("\n");
}

export function readyTasksMarkdown(tasks: Array<{ id: string; title: string; priority: number; status?: string }>): string {
  return [
    ...(tasks.length === 0
      ? ["No ready task is available."]
      : [
          "| task | priority | title | status |",
          "|---|---:|---|---|",
          ...tasks.map((task) => `| ${code(task.id)} | ${task.priority} | ${task.title.replaceAll("|", "\\|")} | ${task.status ?? "ready"} |`),
        ]),
  ].join("\n");
}


export function performanceMarkdown(report: ReturnType<AtelierCore["performanceReport"]>): string {
  const section = (title: string, summary: typeof report.interactive): string[] => [
    `**${title}:** ${summary.sampleCount} sample(s), ${summary.totalDurationMs.toFixed(1)} ms total`,
    ...summary.byPhase.slice(0, 12).map((item) =>
      `- ${item.operation}/${item.phase}: ${item.count} × ${item.averageDurationMs.toFixed(1)} ms avg; ${item.maximumDurationMs.toFixed(1)} ms max; ${item.subprocesses} subprocess(es); ${item.filesHashed} file(s); ${item.bytesHashed} byte(s)`),
  ];
  return [
    ...section("Interactive observations", report.interactive),
    "",
    ...section("SQLite operations", report.sqlite),
  ].join("\n");
}
