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
        const key = keyName(input).toLowerCase();
        if (["return", "enter", "y"].includes(key)) done(true);
        else if (["escape", "esc", "n", "q"].includes(key)) done(false);
        else if (["up", "k"].includes(key)) offset = Math.max(0, offset - 1);
        else if (["down", "j"].includes(key)) offset = Math.min(Math.max(0, options.lines.length - 1), offset + 1);
      },
    } as any;
  });
}

export type RecoveryAction = "continue" | "pause" | "cancel";

export function renderRecoveryDialog(taskId: string, width: number): string[] {
  const lines = [
    `Recovered active task: ${taskId}`,
    "Existing changes are preserved.",
    "Atelier is ready and waiting for your next instruction.",
    "Closure blockers affect /close only; they do not prevent continuing.",
    "",
    "Continue starts one explicit agent turn.",
    "Pause keeps the task and files in place but disables mutation.",
    "Cancel revokes execution and leaves the task and files open.",
  ];
  const fit = (line: string): string => line.length <= width ? line : `${line.slice(0, Math.max(1, width - 1))}…`;
  return [
    fit("Recover active Atelier task"),
    "─".repeat(Math.max(1, Math.min(width, 28))),
    ...lines.map(fit),
    fit("[Enter] Continue task   [P] Pause   [C] Cancel   [Esc] Leave idle"),
  ];
}

export async function recoveryActionDialog(ctx: ExtensionContext, taskId: string): Promise<RecoveryAction | undefined> {
  if (ctx.mode !== "tui" || ctx.ui.custom === undefined) return undefined;
  return await ctx.ui.custom<RecoveryAction | undefined>((_tui, _theme, _keybindings, done) => ({
    render(width: number): string[] { return renderRecoveryDialog(taskId, width); },
    invalidate(): void {},
    handleInput(input: unknown): void {
      const key = keyName(input).toLowerCase();
      if (["return", "enter"].includes(key)) done("continue");
      else if (key === "p") done("pause");
      else if (key === "c") done("cancel");
      else if (["escape", "esc", "q"].includes(key)) done(undefined);
    },
  } as any));
}
