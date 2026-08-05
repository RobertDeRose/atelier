import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createStatusView, statusViewSummary, type AtelierStatus } from "../../../packages/core/src/index.ts";

export type FooterIntelState = "ready" | "indexing" | "degraded" | "offline" | "disabled";


type FooterState = "clean" | "dirty" | "conflicted" | "unknown";

type FooterTheme = {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
};

interface FooterCell {
  plain: string;
  styled: string;
  score: number;
}

export function planStatusText(status: AtelierStatus): string {
  if (status.planStatus === "missing") return "missing";
  return status.planStatus === "approved" ? "approved" : "not approved";
}

export function executionGrantText(status: AtelierStatus): string {
  const grant = status.activeExecutionGrant;
  return grant === undefined ? "none" : `${grant.id} (${grant.status}) for ${grant.taskId}`;
}

export function vcsStatusText(status: AtelierStatus): string {
  const display = status.repositoryDisplay ?? {
    vcs: status.snapshot.vcs,
    ...(status.snapshot.vcs === "jj" && status.snapshot.changeId ? { revision: status.snapshot.changeId.slice(0, 8) } : {}),
    ...(status.snapshot.vcs === "git" ? { revision: status.snapshot.headCommit.slice(0, 8) } : {}),
    state: "unknown" as const,
  };
  if (display.vcs === "jj") return `jj ${display.label ?? display.revision ?? "unknown"}`;
  if (display.vcs === "git") return `git ${display.label ?? display.revision ?? "unknown"}`;
  return "no vcs";
}

function textWidth(value: string): number {
  return Array.from(value).length;
}

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  const chars = Array.from(value);
  if (chars.length <= width) return value;
  if (width === 1) return "…";
  return `${chars.slice(0, width - 1).join("")}…`;
}

function fg(theme: FooterTheme, color: string, text: string): string {
  return theme.fg?.(color, text) ?? text;
}

function bold(theme: FooterTheme, text: string): string {
  return theme.bold?.(text) ?? text;
}

function heading(theme: FooterTheme, value: string): string {
  return fg(theme, "accent", bold(theme, value));
}

function stateColor(state: string): "success" | "warning" | "error" | "muted" | "dim" {
  if (["ready", "clean", "completed"].includes(state)) return "success";
  if (["indexing", "degraded", "dirty", "paused", "blocked"].includes(state)) return "warning";
  if (["offline", "failed", "conflicted"].includes(state)) return "error";
  if (state === "disabled") return "muted";
  return "dim";
}

function stateText(theme: FooterTheme, value: string): string {
  return fg(theme, stateColor(value), value);
}

function cell(plain: string, styled: string, score: number): FooterCell {
  return { plain, styled, score };
}

function joinedCell(parts: Array<{ plain: string; styled?: string }>, score: number): FooterCell {
  return cell(
    parts.map((part) => part.plain).join(""),
    parts.map((part) => part.styled ?? part.plain).join(""),
    score,
  );
}

function align(left: FooterCell, right: FooterCell, width: number): string {
  const leftWidth = textWidth(left.plain);
  const rightWidth = textWidth(right.plain);
  const spaces = Math.max(1, width - leftWidth - rightWidth);
  return `${left.styled}${" ".repeat(spaces)}${right.styled}`;
}

function chooseAligned(left: FooterCell[], right: FooterCell[], width: number): string {
  const candidates = left.flatMap((leftCell) => right.map((rightCell) => ({
    left: leftCell,
    right: rightCell,
    score: leftCell.score + rightCell.score,
    width: textWidth(leftCell.plain) + textWidth(rightCell.plain) + 1,
  })));
  const fitting = candidates
    .filter((candidate) => candidate.width <= width)
    .sort((a, b) => b.score - a.score || b.width - a.width)[0];
  if (fitting !== undefined) return align(fitting.left, fitting.right, width);

  const minimalLeft = left.at(-1) ?? cell("", "", 0);
  const minimalRight = right.at(-1) ?? cell("", "", 0);
  const leftBudget = Math.max(0, Math.floor((width - 1) * 0.45));
  const rightBudget = Math.max(0, width - leftBudget - 1);
  const leftPlain = truncate(minimalLeft.plain, leftBudget);
  const rightPlain = truncate(minimalRight.plain, rightBudget);
  return `${leftPlain}${" ".repeat(Math.max(1, width - textWidth(leftPlain) - textWidth(rightPlain)))}${rightPlain}`;
}

function contextText(ctx: ExtensionContext): string {
  const percent = ctx.getContextUsage?.()?.percent;
  return percent === null || percent === undefined ? "ctx ?" : `ctx ${Math.round(percent)}%`;
}

function runtimeCells(
  ctx: ExtensionContext,
  theme: FooterTheme,
  thinkingLevel?: string,
  modelName?: string,
): FooterCell[] {
  const model = modelName ?? ctx.model?.id ?? ctx.model?.name ?? "model";
  const context = contextText(ctx);
  const header = { plain: "Atelier:", styled: heading(theme, "Atelier:") };
  const separator = { plain: " · ", styled: fg(theme, "dim", " · ") };
  const fullParts = [header, { plain: ` ${model}` }];
  if (thinkingLevel !== undefined && thinkingLevel !== "") {
    fullParts.push(separator, { plain: thinkingLevel });
  }
  fullParts.push(separator, { plain: context, styled: contextState(ctx, theme, context) });
  return [
    joinedCell(fullParts, 5),
    joinedCell([header, { plain: ` ${model}` }, separator, { plain: context, styled: contextState(ctx, theme, context) }], 4),
    joinedCell([header, { plain: ` ${context}`, styled: ` ${contextState(ctx, theme, context)}` }], 2),
  ];
}

function contextState(ctx: ExtensionContext, theme: FooterTheme, value: string): string {
  const percent = ctx.getContextUsage?.()?.percent;
  if (percent === null || percent === undefined) return fg(theme, "dim", value);
  if (percent >= 90) return fg(theme, "error", value);
  if (percent >= 70) return fg(theme, "warning", value);
  return value;
}

function vcsStateIcon(state: FooterState): string {
  if (state === "clean") return "✓";
  if (state === "dirty") return "●";
  if (state === "conflicted") return "!";
  return "?";
}

function vcsCells(status: AtelierStatus, theme: FooterTheme): FooterCell[] {
  const display = status.repositoryDisplay;
  const headingText = display.vcs === "jj" ? "jj:" : display.vcs === "git" ? "git:" : "vcs:";
  const header = { plain: headingText, styled: heading(theme, headingText) };
  const separator = { plain: " · ", styled: fg(theme, "dim", " · ") };
  const identityParts = display.vcs === "jj"
    ? [display.label, display.revision].filter((value): value is string => Boolean(value))
    : [display.label ?? display.revision].filter((value): value is string => Boolean(value));
  const identity = identityParts.length > 0 ? identityParts.join(" · ") : "unknown";
  const compactIdentity = display.label ?? display.revision ?? "unknown";
  const state = display.state;
  const stateValue = `${vcsStateIcon(state)} ${state}`;
  const stateStyled = fg(theme, stateColor(state), stateValue);
  return [
    joinedCell([header, { plain: ` ${identity}` }, separator, { plain: stateValue, styled: stateStyled }], 5),
    joinedCell([header, { plain: ` ${compactIdentity}` }, separator, { plain: stateValue, styled: stateStyled }], 4),
    joinedCell([header, { plain: ` ${truncate(compactIdentity, 12)}` }, separator, { plain: vcsStateIcon(state), styled: fg(theme, stateColor(state), vcsStateIcon(state)) }], 2),
  ];
}

function displayMode(status: AtelierStatus): string {
  return status.workflowCheckpoint === "paused" ? "paused" : status.mode;
}

function conciseBlocker(status: AtelierStatus): string | undefined {
  if (status.currentTaskId === undefined || !status.closureStatus.startsWith("blocked")) return undefined;
  const reason = status.closureStatus.replace(/^blocked\s*[—-]?\s*/i, "").replace(/^Task closure blocked:\s*/i, "");
  if (/diff.*review|review.*diff/i.test(reason)) return "diff review";
  if (/validation/i.test(reason)) return "validation";
  if (/repository.*clean|not clean/i.test(reason)) return "repository dirty";
  if (/local (commit|change)/i.test(reason)) return "local change";
  if (/task provider|provider/i.test(reason)) return "provider";
  return truncate(reason.split(/[.;]/)[0]?.trim() || "blocked", 28);
}

function modeCells(
  status: AtelierStatus,
  theme: FooterTheme,
): FooterCell[] {
  const mode = displayMode(status);
  const header = { plain: "mode:", styled: heading(theme, "mode:") };
  const modePart = { plain: ` ${mode}`, styled: ` ${fg(theme, mode === "paused" ? "warning" : "accent", mode)}` };
  if (status.currentTaskId === undefined) {
    return [joinedCell([header, modePart], 3)];
  }

  const title = status.currentTaskTitle ?? status.currentTaskId;
  const blocker = conciseBlocker(status);
  const taskHeader = { plain: " · task: ", styled: `${fg(theme, "dim", " · ")}${heading(theme, "task:")} ` };
  const closurePending = status.activeExecutionGrant?.status === "active";
  const blockerLabel = closurePending ? "closure:" : "blocked:";
  const blocked = blocker === undefined
    ? []
    : [{ plain: ` · ${blockerLabel} `, styled: `${fg(theme, "dim", " · ")}${heading(theme, blockerLabel)} ` }, { plain: blocker, styled: fg(theme, "warning", blocker) }];
  const blockedShort = blocker === undefined
    ? []
    : [{ plain: closurePending ? " · closure" : " · blocked", styled: `${fg(theme, "dim", " · ")}${stateText(theme, "blocked")}` }];
  return [
    joinedCell([header, modePart, taskHeader, { plain: title }, ...blocked], 7),
    joinedCell([header, modePart, taskHeader, { plain: truncate(title, 28) }, ...blocked], 6),
    joinedCell([header, modePart, taskHeader, { plain: truncate(title, 18) }, ...blockedShort], 5),
    joinedCell([header, modePart, taskHeader, { plain: status.currentTaskId }, ...blockedShort], 4),
    joinedCell([header, modePart], 2),
  ];
}

function intelCell(intel: FooterIntelState, theme: FooterTheme): FooterCell {
  return joinedCell([
    { plain: "intel:", styled: heading(theme, "intel:") },
    { plain: ` ${intel}`, styled: ` ${stateText(theme, intel)}` },
  ], 3);
}

export function renderAtelierFooter(
  ctx: ExtensionContext,
  status: AtelierStatus,
  intel: FooterIntelState,
  width: number,
  theme: FooterTheme = {},
  thinkingLevel?: string,
  modelName?: string,
): string[] {
  return [
    chooseAligned(
      runtimeCells(ctx, theme, thinkingLevel, modelName),
      modeCells(status, theme),
      width,
    ),
    chooseAligned(vcsCells(status, theme), [intelCell(intel, theme)], width),
  ];
}

export function installAtelierFooter(
  ctx: ExtensionContext,
  status: AtelierStatus,
  intel: FooterIntelState,
  thinkingLevel: string | undefined,
  mode: "atelier" | "status-only" | "disabled" = "atelier",
  modelName?: string,
): void {
  if (ctx.mode !== "tui" || ctx.ui.setFooter === undefined) return;
  if (mode !== "atelier") { ctx.ui.setFooter(undefined); return; }
  ctx.ui.setFooter((_tui, theme, footerData) => ({
    render(width: number): string[] {
      void footerData;
      return renderAtelierFooter(
        ctx,
        status,
        intel,
        width,
        theme as FooterTheme,
        thinkingLevel,
        modelName,
      );
    },
    invalidate(): void {},
  }));
}

export function atelierStatusSummary(status: AtelierStatus): string { return statusViewSummary(createStatusView(status)); }
