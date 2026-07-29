import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AtelierStatus } from "../../../packages/core/src/index.ts";

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
): void {
  if (ctx.mode !== "tui" || ctx.ui.setFooter === undefined) return;
  ctx.ui.setFooter((_tui, _theme, _footerData) => ({
    render(width: number): string[] {
      const model = ctx.model?.id ?? ctx.model?.name ?? "model";
      const usage = ctx.getContextUsage?.();
      const usageText = usage?.percent === null || usage?.percent === undefined
        ? ""
        : ` · ${Math.round(usage.percent)}% context`;
      return [fitFooterLine(`pi · ${model} · ${vcsStatusText(status)}    ${atelierStatus}${usageText}`, width)];
    },
    invalidate(): void {},
  }));
}
