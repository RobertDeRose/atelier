import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AtelierCore } from "../../../packages/core/src/index.ts";
import { recordPhaseEvidence } from "./ui-evidence.ts";

const PHASE_WIDGET_KEY = "atelier-phase";
const SPINNER_INTERVAL_MS = 80;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

interface ActivePhase {
  id: string;
  message: string;
  operation?: string;
  startedAt: number;
  core?: AtelierCore;
  widgetVisible: boolean;
}

interface PhaseWidgetTui {
  requestRender(force?: boolean): void;
}

interface PhaseWidgetTheme {
  fg?(color: string, text: string): string;
}

interface PhaseWidgetComponent {
  render(width: number): string[];
  invalidate(): void;
  dispose(): void;
}

const ACTIVE_PHASES = new WeakMap<object, ActivePhase>();

function phaseKey(ctx: ExtensionContext): object {
  const sessionManager = (ctx as ExtensionContext & { sessionManager?: object }).sessionManager;
  return sessionManager ?? (ctx as object);
}

export interface AtelierPhaseOptions {
  core?: AtelierCore;
  operation?: string;
}

function truncateLine(value: string, width: number): string {
  if (width <= 0) return "";
  const chars = Array.from(value);
  if (chars.length <= width) return value;
  if (width === 1) return "…";
  return `${chars.slice(0, width - 1).join("")}…`;
}

function phaseWidgetFactory(message: string) {
  return (tui: PhaseWidgetTui, theme: PhaseWidgetTheme): PhaseWidgetComponent => {
    let frame = 0;
    let disposed = false;
    const timer = setInterval(() => {
      if (disposed) return;
      frame = (frame + 1) % SPINNER_FRAMES.length;
      tui.requestRender();
    }, SPINNER_INTERVAL_MS);
    timer.unref?.();

    return {
      render(width: number): string[] {
        const line = truncateLine(`${SPINNER_FRAMES[frame]} Atelier: ${message}…`, width);
        return [theme.fg?.("muted", line) ?? line];
      },
      invalidate(): void {},
      dispose(): void {
        disposed = true;
        clearInterval(timer);
      },
    };
  };
}

function recordCleared(phase: ActivePhase, reason: string): void {
  if (phase.core === undefined) return;
  recordPhaseEvidence(phase.core, {
    state: "cleared",
    message: phase.message,
    phaseId: phase.id,
    ...(phase.operation === undefined ? {} : { operation: phase.operation }),
    durationMs: Date.now() - phase.startedAt,
    surface: phase.widgetVisible ? "single_line_spinner_and_working" : "native_working_indicator",
    reason,
  });
}

/**
 * Present one transient progress line without replacing durable footer state.
 *
 * Idle slash commands do not activate Pi's built-in streaming loader, so
 * Atelier installs one animated above-editor line that updates in place. Agent
 * and tool turns use Pi's native working indicator instead. The dedicated row
 * never enters the message transcript and never replaces the footer's mode,
 * task, VCS, or intelligence fields.
 */
export async function showAtelierPhase(
  ctx: ExtensionContext,
  message: string,
  options: AtelierPhaseOptions = {},
): Promise<string> {
  const key = phaseKey(ctx);
  const prior = ACTIVE_PHASES.get(key);
  if (prior !== undefined) {
    ctx.ui.setWidget?.(PHASE_WIDGET_KEY, undefined, { placement: "aboveEditor" });
    recordCleared(prior, "replaced");
  }

  const widgetVisible = ctx.mode === "tui" && ctx.isIdle();
  const phase: ActivePhase = {
    id: `phase-${randomUUID()}`,
    message,
    startedAt: Date.now(),
    widgetVisible,
    ...(options.operation === undefined ? {} : { operation: options.operation }),
    ...(options.core === undefined ? {} : { core: options.core }),
  };
  ACTIVE_PHASES.set(key, phase);

  const workingText = `Atelier: ${message}…`;
  ctx.ui.setWorkingMessage?.(workingText);
  if (widgetVisible) {
    ctx.ui.setWidget?.(PHASE_WIDGET_KEY, phaseWidgetFactory(message), { placement: "aboveEditor" });
  }

  // Give Pi a chance to paint the spinner or native working indicator before
  // repository/provider work starts.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (phase.core !== undefined) {
    recordPhaseEvidence(phase.core, {
      state: "presented",
      message,
      phaseId: phase.id,
      ...(phase.operation === undefined ? {} : { operation: phase.operation }),
      surface: widgetVisible ? "single_line_spinner_and_working" : "native_working_indicator",
    });
  }
  return phase.id;
}

export function clearAtelierPhase(
  ctx: ExtensionContext,
  options: { reason?: string } = {},
): void {
  const key = phaseKey(ctx);
  const phase = ACTIVE_PHASES.get(key);
  ACTIVE_PHASES.delete(key);
  ctx.ui.setWidget?.(PHASE_WIDGET_KEY, undefined, { placement: "aboveEditor" });
  ctx.ui.setWorkingMessage?.();
  if (phase !== undefined) recordCleared(phase, options.reason ?? "completed");
}
