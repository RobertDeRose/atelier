import { createHash } from "node:crypto";
import type { AtelierCore } from "../../../packages/core/src/index.ts";

const MAX_VISUAL_TEXT_BYTES = 16 * 1024;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedText(value: string): { text: string; truncated: boolean; bytes: number; sha256: string } {
  const bytes = Buffer.byteLength(value);
  if (bytes <= MAX_VISUAL_TEXT_BYTES) {
    return { text: value, truncated: false, bytes, sha256: sha256(value) };
  }
  const buffer = Buffer.from(value);
  const suffix = buffer.subarray(buffer.length - MAX_VISUAL_TEXT_BYTES).toString("utf8");
  return { text: suffix, truncated: true, bytes, sha256: sha256(value) };
}

export function recordUiEvidence(
  core: AtelierCore,
  kind: string,
  payload: Record<string, unknown>,
): void {
  try {
    const taskId = core.ledger.getState<string>("currentTaskId");
    core.ledger.append({
      kind: `ui.${kind}`,
      actor: "system",
      ...(taskId === undefined ? {} : { taskId }),
      payload,
    });
  } catch {
    // UI evidence is diagnostic, not workflow authority. Late rendering after
    // session shutdown must never fail the user operation or reopen a closed
    // ledger merely to persist presentation state.
  }
}

export function recordReportEvidence(
  core: AtelierCore,
  input: { command: string; title: string; summary: string; markdown: string },
): void {
  recordUiEvidence(core, "report_presented", {
    command: input.command,
    title: input.title,
    summary: input.summary,
    markdown: boundedText(input.markdown),
  });
}

export function recordFooterEvidence(
  core: AtelierCore,
  input: {
    lines: string[];
    width: number;
    model?: string;
    thinkingLevel?: string;
    contextPercent?: number | null;
    mode: string;
    taskId?: string;
    vcs: string;
    vcsState: string;
    intel: string;
  },
): void {
  const text = input.lines.join("\n");
  recordUiEvidence(core, "footer_presented", {
    ...input,
    rendered: boundedText(text),
  });
}

export function recordPhaseEvidence(
  core: AtelierCore,
  input: {
    state: "presented" | "cleared";
    message: string;
    operation?: string;
    phaseId: string;
    durationMs?: number;
    surface: "working" | "widget_and_working";
    reason?: string;
  },
): void {
  recordUiEvidence(core, "phase_changed", input);
}

export function recordModelBashEvidence(
  core: AtelierCore,
  input: {
    state: "started" | "succeeded" | "failed" | "interrupted";
    toolCallId: string;
    command: string;
    exitCode?: number | null;
    durationMs?: number;
    outputBytes?: number;
    updateCount?: number;
    outputSha256?: string;
    capturedOutputBytes?: number;
    outputTruncated?: boolean;
    error?: string;
  },
): void {
  const commandBytes = Buffer.byteLength(input.command);
  recordUiEvidence(core, "model_bash", {
    state: input.state,
    toolCallId: input.toolCallId,
    command: {
      bytes: commandBytes,
      sha256: sha256(input.command),
    },
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.outputBytes === undefined ? {} : {
      outputBytes: input.outputBytes,
      hadOutput: input.outputBytes > 0,
    }),
    ...(input.updateCount === undefined ? {} : { updateCount: input.updateCount }),
    ...(input.outputSha256 === undefined ? {} : {
      output: {
        sha256: input.outputSha256,
        capturedBytes: input.capturedOutputBytes ?? input.outputBytes ?? 0,
        truncated: input.outputTruncated ?? false,
      },
    }),
    ...(input.error === undefined ? {} : {
      error: {
        bytes: Buffer.byteLength(input.error),
        sha256: sha256(input.error),
      },
    }),
  });
}

export function recordAgentSettledEvidence(
  core: AtelierCore,
  input: { isIdle: boolean; mode: string },
): void {
  recordUiEvidence(core, "agent_settled", input);
}

export function recordUserBashDenial(
  core: AtelierCore,
  input: { command: string; exitCode: number; output: string },
): void {
  recordUiEvidence(core, "user_bash_denied", {
    exitCode: input.exitCode,
    output: input.output,
    outputEvidence: boundedText(input.output),
    command: {
      bytes: Buffer.byteLength(input.command),
      sha256: sha256(input.command),
    },
  });
}
