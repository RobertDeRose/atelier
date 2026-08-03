import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AtelierCore, AtelierStatus } from "../../../packages/core/src/index.ts";
import {
  performanceMarkdown,
  statusMarkdown,
  statusSummary,
  workflowSummary,
  workflowStatusMarkdown,
} from "./command-reports.ts";
import { appendAtelierReport } from "./report-presentation.ts";
import { clearAtelierPhase, showAtelierPhase } from "./working-phase.ts";
import { recordReportEvidence } from "./ui-evidence.ts";

export interface StatusCommandDependencies {
  getCore(ctx: ExtensionCommandContext): AtelierCore;
  updateStatus(ctx: ExtensionCommandContext, core: AtelierCore, status?: AtelierStatus): Promise<void>;
}

export function registerStatusCommands(pi: ExtensionAPI, dependencies: StatusCommandDependencies): void {
  pi.registerCommand("status", {
    description: "Show Atelier workflow, plan, task, and policy state",
    handler: async (_args, ctx) => {
      const core = dependencies.getCore(ctx);
      await showAtelierPhase(ctx, "reading status", { core, operation: "/status" });
      try {
        const status = await core.status();
        const markdown = statusMarkdown(status);
        const summary = statusSummary(status);
        appendAtelierReport(pi, ctx, "Atelier status", markdown, summary);
        recordReportEvidence(core, { command: "/status", title: "Atelier status", summary, markdown });
        await dependencies.updateStatus(ctx, core, status);
      } finally {
        clearAtelierPhase(ctx);
      }
    },
  });

  const showWorkflowReport = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const core = dependencies.getCore(ctx);
    const requested = args.trim();
    const full = requested === "--full" || requested === "full" || requested === "refresh";
    await showAtelierPhase(ctx, full ? "refreshing authoritative workflow state" : "reading durable workflow state", { core, operation: full ? "/workflow full" : "/workflow" });
    try {
      if (full) {
        const state = await core.buildWorkingState();
        const markdown = core.workingStateBuilder.toMarkdown(state);
        const summary = workflowSummary(state);
        appendAtelierReport(
          pi,
          ctx,
          "Atelier workflow · full",
          markdown,
          summary,
        );
        recordReportEvidence(core, { command: "/workflow full", title: "Atelier workflow · full", summary, markdown });
        await dependencies.updateStatus(ctx, core);
        return;
      }
      const status = await core.status();
      const markdown = workflowStatusMarkdown(status);
      const summary = status.currentTaskId === undefined
        ? `${status.mode} · no active task`
        : `${status.mode} · task ${status.currentTaskId}`;
      appendAtelierReport(
        pi,
        ctx,
        "Atelier workflow",
        markdown,
        summary,
      );
      recordReportEvidence(core, { command: "/workflow", title: "Atelier workflow", summary, markdown });
      await dependencies.updateStatus(ctx, core, status);
    } finally {
      clearAtelierPhase(ctx);
    }
  };

  pi.registerCommand("workflow", {
    description: "Show durable workflow state; use /workflow full or /workflow refresh for retrieval-backed diagnostics",
    handler: showWorkflowReport,
  });
  pi.registerCommand("state", {
    description: "Compatibility alias for /workflow",
    handler: showWorkflowReport,
  });
  pi.registerCommand("performance", {
    description: "Show bounded interactive, subprocess, hashing, cache, and SQLite timing diagnostics",
    handler: async (args, ctx) => {
      const core = dependencies.getCore(ctx);
      if (args.trim() === "clear") {
        core.clearPerformanceReport();
        ctx.ui.notify("Atelier performance samples cleared.", "info");
        return;
      }
      const report = core.performanceReport(100);
      appendAtelierReport(
        pi,
        ctx,
        "Atelier performance",
        performanceMarkdown(report),
        `${report.interactive.sampleCount + report.sqlite.sampleCount} sample(s)`,
      );
    },
  });
}
