import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AtelierCore,
  CommitFailureError,
  QualityGatePolicyError,
} from "../../../packages/core/src/index.ts";
import { commitFailureActionDialog, confirmApprovalDialog } from "./approval-dialog.ts";

export async function handleCommitFailure(
  ctx: ExtensionContext,
  core: AtelierCore,
  message: string,
  error: unknown,
): Promise<void> {
  if (!(error instanceof CommitFailureError)) throw error;
  ctx.ui.notify([
    error.budgetExhausted
      ? `Commit retry budget exhausted (${error.state.category}; ${error.state.attempt} identical failures).`
      : `Commit failed (${error.state.category}; attempt ${error.state.attempt}).`,
    `Evidence: ${error.state.evidence}`,
  ].join(" "), "warning");
  const action = await commitFailureActionDialog(ctx, error.state.category, error.state.remediation);
  if (action === "retry") {
    try {
      core.recordCommitFailureDecision("retry");
      const result = await core.commitActiveTask(message);
      ctx.ui.notify(`Created local ${result.snapshot.vcs === "jj" ? "change" : "commit"}: ${result.message}`, "info");
    } catch (retryError) {
      if (!(retryError instanceof CommitFailureError)) throw retryError;
      ctx.ui.notify(`Commit remains blocked (${retryError.state.category}); inspect the evidence before another explicit action.`, "warning");
    }
  } else if (action === "pause") {
    core.recordCommitFailureDecision("pause");
    core.execution.pause(`Paused after ${error.state.category} commit failure.`);
    ctx.ui.notify("Task paused after the commit failure.", "warning");
  } else if (action === "cancel") {
    core.recordCommitFailureDecision("cancel");
    core.execution.cancel(`Cancelled after ${error.state.category} commit failure.`);
    ctx.ui.notify("Execution cancelled after the commit failure.", "warning");
  } else {
    core.recordCommitFailureDecision("bypass");
    core.execution.pause("Paused while an explicit commit bypass request is reviewed.");
    ctx.ui.notify("Explicit policy exception request recorded; Atelier did not weaken repository policy or create a commit.", "warning");
  }
}

export async function handleQualityGatePolicyFailure(
  ctx: ExtensionContext,
  core: AtelierCore,
  message: string,
  error: QualityGatePolicyError,
): Promise<void> {
  ctx.ui.notify([
    `Quality gate blocked the commit (${error.evidence.gateId ?? "no gate"}; ${error.evidence.status}).`,
    error.evidence.reason ?? "Inspect the recorded quality-gate evidence before retrying.",
  ].join(" "), "warning");
  const action = await commitFailureActionDialog(ctx, "quality-gate", [
    error.evidence.reason ?? "Inspect the recorded quality-gate evidence before retrying.",
  ], { bypassLabel: "Use one-turn quality-gate bypass" });
  if (action === "retry") {
    try {
      core.recordCommitFailureDecision("retry");
      const result = await core.commitActiveTask(message);
      ctx.ui.notify(`Created local ${result.snapshot.vcs === "jj" ? "change" : "commit"}: ${result.message}`, "info");
    } catch (retryError) {
      if (!(retryError instanceof QualityGatePolicyError) && !(retryError instanceof CommitFailureError)) throw retryError;
      ctx.ui.notify("The quality gate remains blocking; inspect the recorded evidence before another explicit action.", "warning");
    }
  } else if (action === "pause") {
    core.execution.pause("Paused after a quality-gate failure.");
    ctx.ui.notify("Task paused after the quality-gate failure.", "warning");
  } else if (action === "cancel") {
    core.execution.cancel("Cancelled after a quality-gate failure.");
    ctx.ui.notify("Execution cancelled after the quality-gate failure.", "warning");
  } else {
    const bypass = await confirmApprovalDialog(ctx, {
      title: "Use one-turn quality-gate bypass",
      lines: [
        "This skips only the selected quality gate for the next commit.",
        "Git hooks, signing, filters, scope, and repository policy remain active.",
        "The authorization expires before any later commit attempt.",
      ],
      approveLabel: "Use bypass once",
      rejectLabel: "Pause",
    });
    if (!bypass) {
      core.execution.pause("Paused while an explicit commit bypass request is reviewed.");
      ctx.ui.notify("Task paused; no quality-gate bypass was used.", "warning");
    } else {
      try {
        core.authorizeQualityGateBypass("Pi user explicitly authorized one-turn quality-gate bypass.");
        const result = await core.commitActiveTask(message);
        ctx.ui.notify(`Created local ${result.snapshot.vcs === "jj" ? "change" : "commit"} with one-turn quality-gate bypass: ${result.message}`, "warning");
      } catch (bypassError) {
        if (!(bypassError instanceof CommitFailureError) && !(bypassError instanceof QualityGatePolicyError)) throw bypassError;
        ctx.ui.notify("The explicit one-turn bypass did not create a commit; inspect the recorded evidence.", "warning");
      }
    }
  }
}
