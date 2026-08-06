import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ApprovalDialogOptions {
  title: string;
  lines: string[];
  approveLabel?: string;
  rejectLabel?: string;
}

function keyName(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    return String(record.name ?? record.key ?? record.sequence ?? "");
  }
  return "";
}

function matchesInput(input: unknown, names: readonly string[], raw: readonly string[] = []): boolean {
  const name = keyName(input).toLowerCase();
  if (names.includes(name)) return true;
  return typeof input === "string" && raw.includes(input);
}

export function renderApprovalDialog(options: ApprovalDialogOptions, width: number, offset = 0, height = 20): string[] {
  const approve = options.approveLabel ?? "Approve";
  const reject = options.rejectLabel ?? "Reject";
  const body = options.lines.map((line) => line.length <= width ? line : `${line.slice(0, Math.max(1, width - 1))}…`);
  const visible = body.slice(offset, offset + Math.max(1, height - 4));
  const fit = (line: string): string => line.length <= width ? line : `${line.slice(0, Math.max(1, width - 1))}…`;
  return [
    fit(options.title),
    "─".repeat(Math.max(1, Math.min(width, options.title.length + 8))),
    ...visible,
    ...(body.length > visible.length ? [fit(`[${offset + 1}-${offset + visible.length} of ${body.length}] ↑/↓ scroll`)] : []),
    fit(`[Enter/y] ${approve}    [Esc/n] ${reject}`),
  ];
}

export async function confirmApprovalDialog(ctx: ExtensionContext, options: ApprovalDialogOptions): Promise<boolean> {
  if (ctx.mode !== "tui" || ctx.ui.custom === undefined) {
    return await ctx.ui.confirm(options.title, `${options.lines.join("\n")}\n\n${options.approveLabel ?? "Approve"}?`);
  }
  return await ctx.ui.custom<boolean>((_tui, _theme, _keybindings, done) => {
    let offset = 0;
    return {
      render(width: number): string[] { return renderApprovalDialog(options, width, offset); },
      invalidate(): void {},
      handleInput(input: unknown): void {
        if (matchesInput(input, ["return", "enter", "y"], ["\r", "\n", "y"])) done(true);
        else if (matchesInput(input, ["escape", "esc", "n", "q"], ["\x1b", "n", "q"])) done(false);
        else if (matchesInput(input, ["up", "k"], ["\x1b[A", "k"])) {
          offset = Math.max(0, offset - 1);
          _tui.requestRender();
        } else if (matchesInput(input, ["down", "j"], ["\x1b[B", "j"])) {
          offset = Math.min(Math.max(0, options.lines.length - 1), offset + 1);
          _tui.requestRender();
        }
      },
    } as any;
  });
}

export type CommitFailureAction = "retry" | "pause" | "cancel" | "bypass";

const COMMIT_FAILURE_ACTIONS: ReadonlyArray<{ action: CommitFailureAction; label: string }> = [
  { action: "retry", label: "Retry after external remediation" },
  { action: "pause", label: "Pause the task" },
  { action: "cancel", label: "Cancel this execution" },
  { action: "bypass", label: "Record an explicit bypass request (not applied automatically)" },
];

export async function commitFailureActionDialog(
  ctx: ExtensionContext,
  category: string,
  remediation: readonly string[],
): Promise<CommitFailureAction> {
  const labels = COMMIT_FAILURE_ACTIONS.map((item) => item.label);
  const selected = await ctx.ui.select(
    [`Commit blocked · ${category}`, ...remediation, "Choose the next explicit action."].join("\n"),
    labels,
  );
  const index = selected === undefined ? -1 : labels.indexOf(selected);
  return COMMIT_FAILURE_ACTIONS[index < 0 ? 1 : index]?.action ?? "pause";
}

export type RecoveryAction = "continue" | "pause" | "cancel";

const RECOVERY_ACTIONS: ReadonlyArray<{
  action: RecoveryAction;
  label: string;
  description: string;
}> = [
  { action: "continue", label: "Continue task", description: "send one explicit agent turn" },
  { action: "pause", label: "Pause", description: "keep task and files, disable mutation" },
  { action: "cancel", label: "Cancel", description: "revoke execution, leave task open" },
];

function recoveryActionLabel(action: typeof RECOVERY_ACTIONS[number]): string {
  return `${action.label} — ${action.description}`;
}

export async function recoveryActionDialog(
  ctx: ExtensionContext,
  taskId: string,
  taskTitle?: string,
): Promise<RecoveryAction | undefined> {
  if (ctx.mode !== "tui") return undefined;
  const title = [
    `Recover active Atelier task · ${taskId}`,
    ...(taskTitle === undefined || taskTitle.trim() === "" ? [] : [taskTitle.trim()]),
    "Changes preserved · active grant restored.",
    "Closure blockers affect /close only.",
  ].join("\n");
  const labels = RECOVERY_ACTIONS.map(recoveryActionLabel);
  const selected = await ctx.ui.select(title, labels);
  const selectedIndex = selected === undefined ? -1 : labels.indexOf(selected);
  return selectedIndex < 0 ? undefined : RECOVERY_ACTIONS[selectedIndex]?.action;
}
