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

export type RecoveryAction = "continue" | "pause" | "cancel";
type RecoveryDialogTheme = {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
};

const RECOVERY_ACTIONS: Array<{ action: RecoveryAction; label: string; description: string }> = [
  { action: "continue", label: "Continue task", description: "send one explicit agent turn" },
  { action: "pause", label: "Pause", description: "keep task and files, disable mutation" },
  { action: "cancel", label: "Cancel", description: "revoke execution, leave task open" },
];

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  const chars = Array.from(value);
  if (chars.length <= width) return value;
  if (width === 1) return "…";
  return `${chars.slice(0, width - 1).join("")}…`;
}

function wrap(value: string, width: number): string[] {
  if (width <= 0 || value === "") return [""];
  const words = value.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (Array.from(word).length > width) {
      if (current !== "") { lines.push(current); current = ""; }
      let remaining = word;
      while (Array.from(remaining).length > width) {
        lines.push(Array.from(remaining).slice(0, width).join(""));
        remaining = Array.from(remaining).slice(width).join("");
      }
      current = remaining;
    } else if (current === "") current = word;
    else if (Array.from(`${current} ${word}`).length <= width) current = `${current} ${word}`;
    else { lines.push(current); current = word; }
  }
  if (current !== "") lines.push(current);
  return lines.length === 0 ? [""] : lines;
}

function style(theme: RecoveryDialogTheme, color: string, value: string, emphasize = false): string {
  const emphasized = emphasize && theme.bold !== undefined ? theme.bold(value) : value;
  return theme.fg?.(color, emphasized) ?? emphasized;
}

export function renderRecoveryDialog(
  taskId: string,
  width: number,
  taskTitle?: string,
  selectedAction: RecoveryAction = "continue",
  theme: RecoveryDialogTheme = {},
): string[] {
  const frameWidth = Math.max(1, Math.min(78, width));
  if (frameWidth < 6) return [truncate("Recover active Atelier task", frameWidth)];
  const contentWidth = frameWidth - 4;
  const top = style(theme, "borderAccent", `╭${"─".repeat(frameWidth - 2)}╮`);
  const bottom = style(theme, "borderAccent", `╰${"─".repeat(frameWidth - 2)}╯`);
  const row = (plain: string, color = "text", emphasize = false): string => {
    const text = truncate(plain, contentWidth);
    return `│ ${style(theme, color, text, emphasize)}${" ".repeat(Math.max(0, contentWidth - Array.from(text).length))} │`;
  };
  const blank = (): string => row("");
  const lines: string[] = [
    top,
    row("Recover active Atelier task", "accent", true),
    row(`Recovered active task: ${taskId}`, "accent", true),
  ];
  if (taskTitle !== undefined && taskTitle.trim() !== "") {
    for (const titleLine of wrap(taskTitle, contentWidth - 2)) lines.push(row(`  ${titleLine}`, "text"));
  }
  lines.push(
    blank(),
    row("● Changes preserved · active grant restored", "success"),
    row("Closure blockers affect /close only; they do not prevent continuing.", "warning"),
    blank(),
  );
  for (const item of RECOVERY_ACTIONS) {
    const selected = item.action === selectedAction;
    lines.push(row(`${selected ? "›" : " "} ${item.label}  ·  ${item.description}`, selected ? "accent" : "muted", selected));
  }
  lines.push(
    blank(),
    row("↑↓ select  ·  Enter confirm  ·  P pause  ·  C cancel", "dim"),
    row("Esc leave idle", "dim"),
    bottom,
  );
  return lines;
}

export async function recoveryActionDialog(
  ctx: ExtensionContext,
  taskId: string,
  taskTitle?: string,
): Promise<RecoveryAction | undefined> {
  if (ctx.mode !== "tui" || ctx.ui.custom === undefined) return undefined;
  return await ctx.ui.custom<RecoveryAction | undefined>((tui, theme, _keybindings, done) => {
    let selectedIndex = 0;
    return {
      render(width: number): string[] {
        return renderRecoveryDialog(taskId, width, taskTitle, RECOVERY_ACTIONS[selectedIndex]?.action, theme as RecoveryDialogTheme);
      },
      invalidate(): void {},
      handleInput(input: unknown): void {
        if (matchesInput(input, ["return", "enter"], ["\r", "\n"])) {
          done(RECOVERY_ACTIONS[selectedIndex]?.action ?? "continue");
        } else if (matchesInput(input, ["p"], ["p"])) done("pause");
        else if (matchesInput(input, ["c"], ["c"])) done("cancel");
        else if (matchesInput(input, ["escape", "esc", "q"], ["\x1b", "q"])) done(undefined);
        else if (matchesInput(input, ["up", "k"], ["\x1b[A", "k"])) {
          selectedIndex = Math.max(0, selectedIndex - 1);
          tui.requestRender();
        } else if (matchesInput(input, ["down", "j"], ["\x1b[B", "j"])) {
          selectedIndex = Math.min(RECOVERY_ACTIONS.length - 1, selectedIndex + 1);
          tui.requestRender();
        }
      },
    } as any;
  }, {
    overlay: true,
    overlayOptions: {
      width: 78,
      minWidth: 48,
      maxHeight: "90%",
      anchor: "center",
      margin: 1,
    },
  });
}
