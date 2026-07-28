import type { LedgerEvent, WorkingState } from "../domain/types.ts";

/** Render durable Working State without coupling state construction to presentation. */
export function workingStateToMarkdown(state: WorkingState): string {
  const lines: string[] = [
    "# Atelier Working State",
    "",
    `- Mode: ${state.mode}`,
    `- Repository: ${state.snapshot.vcs} workspace ${state.snapshot.workspaceId}`
    + (state.snapshot.vcs === "jj"
      ? ` / change ${state.snapshot.changeId ?? "unknown"} / operation ${state.snapshot.operationId ?? "unknown"}`
      : ` / commit ${state.snapshot.headCommit}`)
    + ` / dirty generation ${state.snapshot.dirtyGeneration}`,
    `- Working state: ${state.stateId}`,
    `- Task selection: ${state.taskSelection.source} — ${state.taskSelection.rationale}`,
    `- Execution grant: ${state.executionGrant === undefined
      ? "none"
      : `${state.executionGrant.id} (${state.executionGrant.status}) for ${state.executionGrant.taskId}`}`,
    `- Workflow checkpoint: ${state.workflowCheckpoint ?? "none"}`,
    `- Plan approval: ${state.planApproval?.id ?? "none"}`,
    `- Reconciliation: ${state.reconciliationTransaction?.id ?? "none"}`,
    `- Task closure: ${state.taskClosure.ready ? "ready" : "blocked"} — ${state.taskClosure.reason}`,
    `- Next action: ${state.nextAction}`,
  ];

  if (state.planObjective) lines.push(`- Planning objective: ${state.planObjective}`);
  if (state.approvedPlanHash) lines.push(`- Approved plan: ${state.approvedPlanHash}`);
  if (state.activeTask) {
    lines.push("", "## Current task", "", `**${state.activeTask.id}: ${state.activeTask.title}**`, "");
    if (state.activeTask.description) lines.push(state.activeTask.description, "");
    if (state.activeTask.acceptanceCriteria.length > 0) {
      lines.push("Completion and validation:");
      for (const criterion of state.activeTask.acceptanceCriteria) lines.push(`- ${criterion}`);
    }
  } else {
    lines.push("", "## Current task", "", "No task is currently selected.");
  }

  if (state.taskDependencies.length > 0) {
    lines.push("", "## Direct dependencies");
    for (const dependency of state.taskDependencies) {
      lines.push(`- ${dependency.id}: ${dependency.title} [${dependency.status}]`);
    }
  }
  if (state.taskBlockers.length > 0) {
    lines.push("", "## Blockers");
    for (const blocker of state.taskBlockers) lines.push(`- ${blocker.id}: ${blocker.title} [${blocker.status}]`);
  }

  if (state.planTask) {
    lines.push("", "## Reviewed plan scope", "", `Plan task: ${state.planTask.id} — ${state.planTask.title}`);
    if (state.planTask.scope.length > 0) lines.push("", "In scope:", ...state.planTask.scope.map((item) => `- ${item}`));
    if (state.planTask.outOfScope.length > 0) lines.push("", "Out of scope:", ...state.planTask.outOfScope.map((item) => `- ${item}`));
  }

  lines.push("", "## Active permissions");
  if (state.permissions.length === 0) lines.push("", "No mutation permissions are active.");
  for (const grant of state.permissions) lines.push(`- ${grant.permission} (${grant.scope}): ${grant.reason}`);

  lines.push("", "## Execution evidence");
  if (state.executionEvidence.length === 0) lines.push("", "No mutating tool execution evidence is recorded.");
  for (const item of state.executionEvidence) {
    lines.push(`- ${item.toolName}/${item.action}: ${item.status}; observed mutation: ${item.observedMutation}; changed paths: ${item.changedPaths.join(", ") || "none"}`);
  }

  lines.push("", "## Focused validation selection");
  if (state.focusedValidationSelections.length === 0) lines.push("", "No focused validation selection is recorded.");
  for (const selection of state.focusedValidationSelections) {
    lines.push(`- ${selection.id}: ${selection.noMatch ? "no matching focused validations" : selection.selected.map((item) => `${item.name}${item.required ? " (required)" : ""}`).join(", ")}`);
  }

  if (state.currentValidationEvidence.length > 0) {
    lines.push("", "## Current validation evidence");
    for (const item of state.currentValidationEvidence) lines.push(`- ${item.name}: ${item.status} (${item.durationMs} ms)`);
  }
  if (state.staleValidationEvidence.length > 0) {
    lines.push("", "## Stale validation evidence");
    for (const item of state.staleValidationEvidence) lines.push(`- ${item.name}: ${item.status}; ${item.staleReason ?? "repository fingerprint changed"}`);
  }

  if (state.retrievalSession !== undefined) {
    const session = state.retrievalSession;
    lines.push(
      "",
      "## Retrieval session",
      "",
      `- Session: ${session.id}`,
      `- Provider calls: ${session.telemetry.providerCalls}; cache hits: ${session.telemetry.cacheHits}; overlap reuses: ${session.telemetry.overlapReuses}`,
      `- Unique paths: ${session.telemetry.uniquePaths}; duplicate results removed: ${session.telemetry.duplicateResultsRemoved}; duplicate paths removed: ${session.telemetry.duplicatePathsRemoved}`,
      `- Bytes returned: ${session.telemetry.bytesReturned}; truncated: ${session.telemetry.truncated}`,
      `- Invalidations: ${session.telemetry.invalidations}`,
      `- Request budget: ${session.budget.providerRequestsUsed}/${session.budget.providerRequestsLimit}; result paths: ${session.budget.uniquePathsUsed}/${session.budget.uniquePathsLimit}; compact entries: ${session.budget.evidenceEntriesUsed}/${session.budget.evidenceEntriesLimit}`,
      `- Fetch budget: ${session.budget.fetchesUsed}/${session.budget.fetchesLimit}; bytes: ${session.budget.bytesUsed}/${session.budget.bytesLimit}`,
      `- Persisted sessions: ${session.persistence.retainedSessionsUsed}/${session.persistence.retainedSessionsLimit}; entries: ${session.persistence.entriesUsed}/${session.persistence.entriesLimit}; bytes: ${session.persistence.bytesUsed}/${session.persistence.bytesLimit}`,
      `- Inventory freshness: ${session.freshness}`,
      `- Known paths: ${session.knownPaths.join(", ") || "none"}`,
      `- Resolved symbols: ${session.resolvedSymbols.join(", ") || "none"}`,
      `- Unresolved symbols: ${session.unresolvedSymbols.join(", ") || "none"}`,
    );
    if (session.bindings.length > 0) {
      lines.push("", "Freshness and revision bindings:");
      for (const binding of session.bindings) {
        lines.push(`- ${binding.provider.name}/${binding.provider.instanceId} workspace ${binding.workspaceId}; index ${binding.indexRevision ?? "unknown"}; repositories ${binding.repositories.map((item) => `${item.repositoryId}@${item.headCommit}:${item.dirtyFingerprint}`).join(", ")}`);
      }
    }
    if (session.inventory.length > 0) {
      lines.push("", "Compact evidence inventory:");
      for (const item of session.inventory) lines.push(`- [${item.freshness}] ${item.provider}:${item.repositoryId}:${item.path}${item.symbol === undefined ? "" : ` (${item.symbol})`}`);
    }
    if (session.decisions.length > 0) {
      lines.push("", "Provider-call and reuse decisions:");
      for (const item of session.decisions) lines.push(`- ${item.operation}/${item.decision.kind}: ${item.decision.reason}`);
    }
    if (session.diagnostics.length > 0) {
      lines.push("", "Retrieval diagnostics:");
      for (const item of session.diagnostics) lines.push(`- ${item.code}: ${item.message}`);
    }
  }

  if (state.retrievalQueries.length > 0) {
    lines.push("", "## Repository retrieval plan");
    for (const query of state.retrievalQueries) {
      lines.push(
        `- ${query.purpose} [${query.focus}]: ${query.text}`
        + (query.literalHints.length === 0 ? "" : `; hints: ${query.literalHints.join(", ")}`)
        + `; results: ${query.resultCount}`
        + (query.degraded ? "; degraded" : ""),
      );
    }
  }
  if (state.codeEvidence.length > 0) {
    lines.push("", "## Code evidence");
    for (const item of state.codeEvidence) {
      lines.push(
        `- [${item.provider}/${item.queryPurpose}/${item.retrievalMethods.join("+")}] ${item.repositoryId}:${item.path}`
        + (item.startLine === undefined ? "" : `:${item.startLine}`)
        + (item.symbol === undefined ? "" : ` (${item.symbol})`)
        + (item.indexState === "ready" ? "" : ` [${item.indexState}]`)
        + (item.degraded ? " [degraded]" : "")
        + `: ${item.preview ?? ""}`,
      );
    }
  }
  if (state.validationEvidence.length > 0) {
    lines.push("", "## Validation evidence");
    for (const item of state.validationEvidence) lines.push(`- ${item.name}: ${item.status} (${item.durationMs} ms)`);
  }
  if (state.manualEdits.length > 0) {
    lines.push("", "## Manual Edits");
    for (const event of state.manualEdits) lines.push(`- ${event.occurredAt}: ${manualEditText(event)}`);
  }
  if (state.corrections.length > 0) {
    lines.push("", "## User corrections");
    for (const event of state.corrections) lines.push(`- ${event.occurredAt}: ${eventText(event)}`);
  }
  if (state.findings.length > 0) {
    lines.push("", "## Findings and decisions");
    for (const event of state.findings) lines.push(`- ${event.occurredAt}: ${eventText(event)}`);
  }
  if (state.retrievalExplanation.length > 0) {
    lines.push("", "## Retrieval explanation");
    for (const explanation of state.retrievalExplanation) lines.push(`- ${explanation}`);
  }
  if (state.omissions.length > 0) {
    lines.push("", "## Omissions");
    for (const omission of state.omissions) lines.push(`- ${omission}`);
  }
  return `${lines.join("\n")}\n`;
}

function eventText(event: LedgerEvent): string {
  if (typeof event.payload === "string") return event.payload;
  if (typeof event.payload === "object" && event.payload !== null) {
    const record = event.payload as Record<string, unknown>;
    for (const key of ["message", "text", "summary", "reason"]) if (typeof record[key] === "string") return record[key] as string;
  }
  return JSON.stringify(event.payload);
}

function manualEditText(event: LedgerEvent): string {
  if (typeof event.payload !== "object" || event.payload === null) return eventText(event);
  const record = event.payload as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : "unknown path";
  const changed = typeof record.changed === "boolean" ? record.changed : undefined;
  return `${path}${changed === undefined ? "" : changed ? " changed" : " reviewed without textual change"}`;
}

