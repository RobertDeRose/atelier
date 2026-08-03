import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AtelierCore } from "../../../packages/core/src/index.ts";
import { recordPhaseEvidence } from "./ui-evidence.ts";

export const ATELIER_PHASE_STATUS_KEY = "atlr-phase";

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
    surface: "inline_status_and_working",
    reason,
  });
}

/**
 * Show one inline phase message while Pi is idle and use Pi's own working
 * spinner while an agent turn is streaming. Atelier deliberately avoids an
 * above-editor widget because transient phase text should not enter the
 * transcript-like message area or flash as plain text before being cleared.
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

  const workingText = `Atelier: ${message}…`;
  ctx.ui.setWorkingMessage?.(workingText);
  (ctx.ui as typeof ctx.ui & { setStatus?: (key: string, text: string | undefined) => void })
    .setStatus?.(ATELIER_PHASE_STATUS_KEY, `${message}…`);

  // Give Pi a chance to paint the inline footer status or spinner before expensive work starts.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (phase.core !== undefined) {
    recordPhaseEvidence(phase.core, {
      state: "presented",
      message,
      phaseId: phase.id,
      ...(phase.operation === undefined ? {} : { operation: phase.operation }),
      surface: "inline_status_and_working",
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
  ctx.ui.setWorkingMessage?.();
  (ctx.ui as typeof ctx.ui & { setStatus?: (key: string, text: string | undefined) => void })
    .setStatus?.(ATELIER_PHASE_STATUS_KEY, undefined);
  if (phase !== undefined) recordCleared(phase, options.reason ?? "completed");
}
