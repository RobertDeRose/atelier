import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
  AtelierCore,
  AtelierStatus,
  DstackAudit,
  DstackFeatureInspection,
  DstackImplementationPreparation,
  DstackLifecycleTransition,
  QualityGateProfile,
} from "../../../packages/core/src/index.ts";
import { appendAtelierReport } from "./report-presentation.ts";
import { recordReportEvidence } from "./ui-evidence.ts";
import { clearAtelierPhase, showAtelierPhase } from "./working-phase.ts";

export interface DstackCommandDependencies {
  getCore(ctx: ExtensionCommandContext): AtelierCore;
  updateStatus(ctx: ExtensionCommandContext, core: AtelierCore): Promise<void>;
}

function words(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

function flagValue(tokens: readonly string[], name: string): string | undefined {
  const index = tokens.indexOf(name);
  if (index < 0) return undefined;
  if (name === "--reason") {
    const value = tokens.slice(index + 1).filter((token) => !token.startsWith("--")).join(" ").trim();
    return value || undefined;
  }
  return tokens[index + 1];
}

function discoveryOptions(ctx: ExtensionCommandContext): { signal?: AbortSignal } {
  const signal = (ctx as ExtensionCommandContext & { signal?: AbortSignal }).signal;
  return signal === undefined ? {} : { signal };
}

function featureId(core: AtelierCore, value: string | undefined): string {
  const id = value?.trim() || core.ledger.getState<string>("dstack.feature.id");
  if (!id) throw new Error("Usage: /dstack <operation> FEATURE_ID");
  return id;
}

function inspectionMarkdown(inspection: DstackFeatureInspection): string {
  return [
    `## ${inspection.feature.title}`,
    "",
    `- Feature: \`${inspection.feature.id}\``,
    `- State: **${inspection.status}** · phase **${inspection.phase}**`,
    ...(inspection.metadata.featureSlug === undefined ? [] : [`- Slug: \`${inspection.metadata.featureSlug}\``]),
    ...(inspection.metadata.designPath === undefined ? [] : [`- Design: \`${inspection.metadata.designPath}\``]),
    `- Snapshot: **current** · \`${inspection.snapshot.vcs} ${inspection.snapshot.headCommit}\``,
    `- Active task: ${inspection.activeTaskId === undefined ? "none" : `\`${inspection.activeTaskId}\``}`,
    `- Ready tasks: ${inspection.readyTasks.map((task) => `\`${task.id}\``).join(", ") || "none"}`,
    `- Blockers: ${inspection.blockers.map((task) => `${task.id} — ${task.title}`).join("; ") || "none"}`,
    `- Missing dependencies: ${inspection.missingDependencies.join(", ") || "none"}`,
    `- Next action: ${inspection.nextAction}`,
  ].join("\n");
}

function statusMarkdown(status: AtelierStatus): string {
  return [
    "## Core workflow status",
    "",
    `- Workflow next action: ${status.nextAction}`,
    `- Workflow checkpoint: ${status.workflowCheckpoint}`,
    `- Scope: ${status.activeTaskConstraints.flatMap((constraint) => constraint.writePaths).join(", ") || "none active"}`,
    `- Closure: ${status.closureStatus}`,
  ].join("\n");
}

function gateMarkdown(profile: QualityGateProfile): string {
  return [
    "## Repository checks",
    "",
    `- Selected check: ${profile.selectedGateId === undefined ? "none" : `\`${profile.selectedGateId}\``}`,
    `- Overall state: **${profile.noGate ? "no check discovered" : "checks available"}**`,
    ...profile.gates.filter((gate) => gate.kind !== "no-gate").map((gate) =>
      `- ${gate.id}: ${gate.availability}; ${gate.tool.name} ${gate.tool.version}${gate.reason === undefined ? "" : ` — ${gate.reason}`}`),
    ...(profile.omissions.length === 0 ? [] : ["", "### Omitted inventory", ...profile.omissions.map((omission) => `- ${omission}`)]),
  ].join("\n");
}

function transitionMarkdown(transition: DstackLifecycleTransition): string {
  return [
    `## Dstack ${transition.action}`,
    "",
    `- Feature: \`${transition.after.feature.id}\``,
    `- State: **${transition.after.status}** · phase **${transition.after.phase}**`,
    `- Snapshot: **current** · \`${transition.snapshot.vcs} ${transition.snapshot.headCommit}\``,
  ].join("\n");
}

function preparationMarkdown(preparation: DstackImplementationPreparation): string {
  return [
    inspectionMarkdown(preparation.feature),
    "",
    `## Implementation task`,
    "",
    `- Selected: \`${preparation.task.id}\` — ${preparation.task.title}`,
    `- Ready tasks: ${preparation.readyTasks.map((task) => `\`${task.id}\``).join(", ") || "none"}`,
    "- Mutation still requires an explicit task execution grant.",
  ].join("\n");
}

function auditMarkdown(audit: DstackAudit): string {
  return [
    inspectionMarkdown(audit.inspection),
    "",
    "## Closure audit",
    "",
    `- Close ready: **${audit.closeReady}**`,
    `- Blockers: ${audit.closeBlockers.join("; ") || "none"}`,
  ].join("\n");
}

function summary(operation: string, inspection?: DstackFeatureInspection, profile?: QualityGateProfile): string {
  if (profile !== undefined) return `${profile.noGate ? "no repository check" : `${profile.selectedGateId ?? "checks"} available`}`;
  return inspection === undefined ? operation : `${inspection.feature.id} · ${inspection.status} · ${inspection.phase}`;
}

export function registerDstackCommands(pi: ExtensionAPI, dependencies: DstackCommandDependencies): void {
  pi.registerCommand("dstack", {
    description: "Use the shared dstack feature lifecycle, recovery, status, and repository checks",
    handler: async (args, ctx) => {
      const tokens = words(args);
      const operation = tokens[0] ?? "status";
      const core = dependencies.getCore(ctx);
      const phaseMessage = operation === "gates" ? "reading repository checks" : `dstack ${operation}`;
      await showAtelierPhase(ctx, phaseMessage, { core, operation: `/dstack ${operation}` });
      try {
        if (operation === "gates") {
          const profile = await core.qualityGates.discover(discoveryOptions(ctx));
          const markdown = gateMarkdown(profile);
          const title = "Dstack repository checks";
          appendAtelierReport(pi, ctx, title, markdown, summary(operation, undefined, profile));
          recordReportEvidence(core, { command: "/dstack gates", title, summary: summary(operation, undefined, profile), markdown });
          return;
        }

        const id = featureId(core, tokens[1]);
        let markdown: string;
        let title = `Dstack ${operation}`;
        let reportSummary: string;
        if (operation === "inspect") {
          const inspection = await core.dstack.inspectFeature(id);
          markdown = inspectionMarkdown(inspection);
          reportSummary = summary(operation, inspection);
        } else if (operation === "status") {
          const inspection = await core.dstack.inspectFeature(id);
          const [profile, status] = await Promise.all([
            core.qualityGates.discover(discoveryOptions(ctx)),
            core.status(),
          ]);
          markdown = `${inspectionMarkdown(inspection)}\n\n${statusMarkdown(status)}\n\n${gateMarkdown(profile)}`;
          reportSummary = summary(operation, inspection);
        } else if (operation === "audit") {
          const audit = await core.dstack.auditFeature(id);
          markdown = auditMarkdown(audit);
          reportSummary = `${id} · ${audit.closeReady ? "ready to close" : `${audit.closeBlockers.length} blocker(s)`}`;
        } else if (operation === "pause") {
          const reason = flagValue(tokens, "--reason") ?? tokens.slice(2).filter((token) => !token.startsWith("--")).join(" ");
          if (!reason) throw new Error("Usage: /dstack pause FEATURE_ID --reason TEXT");
          const transition = await core.dstack.pauseFeature(id, reason);
          if (transition === undefined) throw new Error("Dstack pause was not applied.");
          markdown = transitionMarkdown(transition);
          reportSummary = summary(operation, transition.after);
        } else if (["start", "implement", "review", "recover", "close"].includes(operation)) {
          const confirmed = await ctx.ui.confirm("Confirm dstack lifecycle action", `Apply ${operation} to feature ${id}?`);
          if (!confirmed) {
            ctx.ui.notify("Dstack lifecycle action cancelled.", "info");
            return;
          }
          if (operation === "start") {
            const transition = await core.dstack.startFeature(id, true);
            if (transition === undefined) throw new Error("Dstack start was not confirmed.");
            markdown = transitionMarkdown(transition);
            reportSummary = summary(operation, transition.after);
          } else if (operation === "implement") {
            const preparation = await core.dstack.prepareImplementation(id, tokens[2]);
            markdown = preparationMarkdown(preparation);
            reportSummary = `${preparation.task.id} selected; execution grant still required`;
          } else if (operation === "review") {
            const transition = await core.dstack.beginReview(id, true);
            if (transition === undefined) throw new Error("Dstack review was not confirmed.");
            markdown = transitionMarkdown(transition);
            reportSummary = summary(operation, transition.after);
          } else if (operation === "recover") {
            const transition = await core.dstack.resumeFeature(id, true);
            if (transition === undefined) throw new Error("Dstack recovery was not confirmed.");
            markdown = transitionMarkdown(transition);
            reportSummary = summary(operation, transition.after);
          } else {
            const reason = flagValue(tokens, "--reason") ?? tokens.slice(2).filter((token) => !token.startsWith("--")).join(" ");
            if (!reason) throw new Error("Usage: /dstack close FEATURE_ID --reason TEXT");
            const reviewComplete = await ctx.ui.confirm("Confirm review evidence", "Is the current feature review complete?");
            if (!reviewComplete) return;
            const gatesComplete = await ctx.ui.confirm("Confirm repository checks", "Are the current repository checks complete?");
            if (!gatesComplete) return;
            const transition = await core.dstack.closeFeature(id, { confirmed: true, reason, reviewComplete: true, gatesComplete: true });
            if (transition === undefined) throw new Error("Dstack close was not confirmed.");
            markdown = transitionMarkdown(transition);
            reportSummary = summary(operation, transition.after);
          }
        } else {
          throw new Error("Usage: /dstack <status|gates|inspect|start|implement|review|audit|pause|recover|close> FEATURE_ID");
        }
        appendAtelierReport(pi, ctx, title, markdown, reportSummary);
        recordReportEvidence(core, { command: `/dstack ${operation}`, title, summary: reportSummary, markdown });
      } finally {
        try {
          await dependencies.updateStatus(ctx, core);
        } finally {
          clearAtelierPhase(ctx);
        }
      }
    },
  });
}
