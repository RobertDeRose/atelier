import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AtelierCore } from "../../../packages/core/src/index.ts";
import { recordPhaseEvidence } from "./ui-evidence.ts";

const PHASE_STATUS_KEY = "atlr-phase";
const PHASE_WIDGET_KEY = "atelier-phase";

interface ActivePhase {
  id: string;
  message: string;
  operation?: string;
  startedAt: number;
  core?: AtelierCore;
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

function recordCleared(phase: ActivePhase, reason: string): void {
  if (phase.core === undefined) return;
  recordPhaseEvidence(phase.core, {
    state: "cleared",
    message: phase.message,
    phaseId: phase.id,
    ...(phase.operation === undefined ? {} : { operation: phase.operation }),
    durationMs: Date.now() - phase.startedAt,
    surface: "widget_and_working",
    reason,
  });
}

/**
 * Show feedback that is visible while Pi is idle and while it is streaming.
 *
 * `setWorkingMessage()` only changes Pi's streaming loader. Slash-command work
 * runs while Pi is idle, so Atelier also installs a temporary above-editor
 * widget and status entry, then yields one event-loop turn before beginning
 * repository or provider I/O. The exact presented state is persisted to the
 * Atelier ledger for acceptance evidence.
 */
export async function showAtelierPhase(
  ctx: ExtensionContext,
  message: string,
  options: AtelierPhaseOptions = {},
): Promise<string> {
  const key = phaseKey(ctx);
  const prior = ACTIVE_PHASES.get(key);
  if (prior !== undefined) recordCleared(prior, "replaced");

  const phase: ActivePhase = {
    id: `phase-${randomUUID()}`,
    message,
    startedAt: Date.now(),
    ...(options.operation === undefined ? {} : { operation: options.operation }),
    ...(options.core === undefined ? {} : { core: options.core }),
  };
  ACTIVE_PHASES.set(key, phase);

  const text = `Atelier: ${message}…`;
  ctx.ui.setWidget?.(PHASE_WIDGET_KEY, [text], { placement: "aboveEditor" });
  ctx.ui.setWorkingMessage?.(text);
  (ctx.ui as typeof ctx.ui & { setStatus?: (key: string, text: string | undefined) => void })
    .setStatus?.(PHASE_STATUS_KEY, text);

  // Give Pi a chance to paint the widget before expensive work starts.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (phase.core !== undefined) {
    recordPhaseEvidence(phase.core, {
      state: "presented",
      message,
      phaseId: phase.id,
      ...(phase.operation === undefined ? {} : { operation: phase.operation }),
      surface: "widget_and_working",
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
  ctx.ui.setWidget?.(PHASE_WIDGET_KEY, undefined);
  ctx.ui.setWorkingMessage?.();
  (ctx.ui as typeof ctx.ui & { setStatus?: (key: string, text: string | undefined) => void })
    .setStatus?.(PHASE_STATUS_KEY, undefined);
  if (phase !== undefined) recordCleared(phase, options.reason ?? "completed");
}
