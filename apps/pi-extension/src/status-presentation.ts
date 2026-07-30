import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createStatusView, statusViewSummary, type AtelierStatus } from "../../../packages/core/src/index.ts";

export function planStatusText(status: AtelierStatus): string {
  if (status.planStatus === "missing") return "missing";
  return status.planStatus === "approved" ? "approved" : "not approved";
}

export function executionGrantText(status: AtelierStatus): string {
  const grant = status.activeExecutionGrant;
  return grant === undefined ? "none" : `${grant.id} (${grant.status}) for ${grant.taskId}`;
}

export function vcsStatusText(status: AtelierStatus): string {
  if (status.snapshot.vcs === "jj") return `jj ${(status.snapshot.changeId ?? "unknown").slice(0, 8)}`;
  if (status.snapshot.vcs === "git") return `git ${status.snapshot.headCommit.slice(0, 8)}`;
  return "no vcs";
}

function fitFooterLine(value: string, width: number): string {
  if (width <= 0 || value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

export function installAtelierFooter(
  ctx: ExtensionContext,
  status: AtelierStatus,
  atelierStatus: string,
  mode: "atelier" | "status-only" | "disabled" = "atelier",
): void {
  if (ctx.mode !== "tui" || ctx.ui.setFooter === undefined) return;
  if (mode !== "atelier") { ctx.ui.setFooter(undefined); return; }
  ctx.ui.setFooter((_tui, _theme, footerData) => ({
    render(width: number): string[] {
      const model = ctx.model?.id ?? ctx.model?.name ?? "model";
      const usage = ctx.getContextUsage?.();
      const usageText = usage?.percent === null || usage?.percent === undefined
        ? ""
        : ` · ${Math.round(usage.percent)}% context`;
      const data = footerData !== null && typeof footerData === "object" ? footerData as Record<string, unknown> : {};
      const cost = typeof data.cost === "number" ? ` · $${data.cost.toFixed(3)}` : "";
      const tokens = typeof data.tokens === "number" ? ` · ${data.tokens} tokens` : "";
      const session = typeof data.sessionName === "string" && data.sessionName ? ` · ${data.sessionName}` : "";
      return [fitFooterLine(`pi · ${model}${session} · ${vcsStatusText(status)}    ${atelierStatus}${usageText}${tokens}${cost}`, width)];
    },
    invalidate(): void {},
  }));
}

export function atelierStatusSummary(status: AtelierStatus): string { return statusViewSummary(createStatusView(status)); }
