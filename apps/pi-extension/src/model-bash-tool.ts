import { createHash } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AtelierCore } from "../../../packages/core/src/index.ts";
import { createAtelierBashOperations } from "./bash-operations.ts";
import { objectSchema, stringSchema } from "./code-tool-presentation.ts";
import { recordModelBashEvidence } from "./ui-evidence.ts";
import { clearAtelierPhase, showAtelierPhase } from "./working-phase.ts";

const UPDATE_INTERVAL_MS = 100;
const MAX_CAPTURED_OUTPUT_CHARS = 200_000;

export interface ModelBashAuthorization {
  allowUnsandboxed: boolean;
}

export interface ModelBashToolDependencies {
  getCore(ctx: ExtensionContext): AtelierCore;
  takeAuthorization(ctx: ExtensionContext, toolCallId: string): ModelBashAuthorization | undefined;
}

interface ModelBashDetails {
  exitCode?: number | null;
  outputBytes: number;
  updateCount: number;
  durationMs: number;
}

function appendBounded(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  if (next.length <= MAX_CAPTURED_OUTPUT_CHARS) return next;
  return next.slice(next.length - MAX_CAPTURED_OUTPUT_CHARS);
}

/**
 * Pi-compatible model Bash tool with Atelier authorization and sandboxing.
 *
 * The tool owns a complete start/update/end lifecycle. It always settles its
 * promise, emits the final captured output, clears Atelier's inline phase, and
 * records durable visual/lifecycle evidence. The underlying bounded process
 * runner also resolves after a parent exits even when a detached descendant
 * keeps inherited stdio open, preventing Pi's Working indicator from hanging.
 */
export function createPolicyControlledBashTool(
  dependencies: ModelBashToolDependencies,
): Parameters<ExtensionAPI["registerTool"]>[0] {
  return {
    name: "bash",
    label: "bash (Atelier policy-controlled)",
    description: "Run a shell command through Atelier effect analysis and workflow controls. Enforced mode uses an OS sandbox when available and prompts for unsandboxed execution; core-only mode intentionally skips both gates.",
    promptSnippet: "Use Atelier's policy-controlled shell; prefer typed tools; core-only mode intentionally runs without permission prompts or an OS sandbox",
    executionMode: "sequential",
    parameters: objectSchema({
      command: stringSchema("Shell command to execute."),
      timeout: { type: "number", description: "Optional timeout in seconds." },
    }, ["command"]),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const core = dependencies.getCore(ctx);
      const authorization = dependencies.takeAuthorization(ctx, toolCallId);
      if (authorization === undefined) {
        const message = "Atelier shell execution failed closed because no matching workspace-policy authorization was recorded.";
        recordModelBashEvidence(core, {
          state: "failed",
          toolCallId,
          command: String((params as { command?: unknown }).command ?? ""),
          error: message,
        });
        throw new Error(message);
      }

      const input = params as { command: string; timeout?: number };
      const startedAt = Date.now();
      let output = "";
      let outputBytes = 0;
      const outputHash = createHash("sha256");
      let updateCount = 0;
      let updateDirty = false;
      let failureRecorded = false;
      let updateTimer: NodeJS.Timeout | undefined;
      let acceptingOutput = true;

      const currentDetails = (exitCode?: number | null): ModelBashDetails => ({
        ...(exitCode === undefined ? {} : { exitCode }),
        outputBytes,
        updateCount,
        durationMs: Date.now() - startedAt,
      });

      const emitUpdate = (): void => {
        if (!acceptingOutput || !updateDirty || onUpdate === undefined) return;
        updateDirty = false;
        updateCount += 1;
        onUpdate({
          content: [{ type: "text", text: output }],
          details: currentDetails(),
        });
      };

      const scheduleUpdate = (): void => {
        if (onUpdate === undefined) return;
        updateDirty = true;
        if (updateTimer !== undefined) return;
        updateTimer = setTimeout(() => {
          updateTimer = undefined;
          emitUpdate();
        }, UPDATE_INTERVAL_MS);
        updateTimer.unref?.();
      };

      const finishUpdates = (): void => {
        if (updateTimer !== undefined) {
          clearTimeout(updateTimer);
          updateTimer = undefined;
        }
        emitUpdate();
        acceptingOutput = false;
      };

      onUpdate?.({ content: [], details: undefined });
      await showAtelierPhase(ctx, "running approved shell command", {
        core,
        operation: "model-bash",
      });
      recordModelBashEvidence(core, {
        state: "started",
        toolCallId,
        command: input.command,
        outputBytes: 0,
        updateCount: 0,
      });

      const operations = createAtelierBashOperations({
        workspace: core.config.workspaceRoot,
        backend: core.config.sandboxBackend,
        allowUnsandboxed: authorization.allowUnsandboxed,
      });

      try {
        const result = await operations.exec(input.command, ctx.cwd, {
          onData(chunk) {
            if (!acceptingOutput) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
            const text = buffer.toString("utf8");
            outputBytes += buffer.length;
            outputHash.update(buffer);
            output = appendBounded(output, text);
            scheduleUpdate();
          },
          ...(signal === undefined ? {} : { signal }),
          ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
        });

        finishUpdates();
        const finalText = output.trimEnd() || "(no output)";
        const finalDetails = currentDetails(result.exitCode);
        const outputSha256 = outputHash.digest("hex");
        const capturedOutputBytes = Buffer.byteLength(output);
        const outputTruncated = capturedOutputBytes < outputBytes;
        if (result.exitCode !== 0 && result.exitCode !== null) {
          const message = `${finalText}\n\nCommand exited with code ${result.exitCode}`;
          recordModelBashEvidence(core, {
            state: "failed",
            toolCallId,
            command: input.command,
            exitCode: result.exitCode,
            durationMs: finalDetails.durationMs,
            outputBytes,
            updateCount,
            outputSha256,
            capturedOutputBytes,
            outputTruncated,
            error: message,
          });
          failureRecorded = true;
          throw new Error(message);
        }

        recordModelBashEvidence(core, {
          state: "succeeded",
          toolCallId,
          command: input.command,
          exitCode: result.exitCode,
          durationMs: finalDetails.durationMs,
          outputBytes,
          updateCount,
          outputSha256,
          capturedOutputBytes,
          outputTruncated,
        });
        return {
          content: [{ type: "text", text: finalText }],
          details: finalDetails,
        };
      } catch (error) {
        finishUpdates();
        const message = error instanceof Error ? error.message : String(error);
        const interrupted = signal?.aborted === true || /\baborted\b/i.test(message);
        if (!failureRecorded) {
          const outputSha256 = outputHash.digest("hex");
          const capturedOutputBytes = Buffer.byteLength(output);
          recordModelBashEvidence(core, {
            state: interrupted ? "interrupted" : "failed",
            toolCallId,
            command: input.command,
            durationMs: Date.now() - startedAt,
            outputBytes,
            updateCount,
            outputSha256,
            capturedOutputBytes,
            outputTruncated: capturedOutputBytes < outputBytes,
            error: message,
          });
        }
        if (failureRecorded || interrupted) throw error instanceof Error ? error : new Error(message);
        const captured = output.trimEnd();
        throw new Error(captured ? `${captured}\n\nSandboxed shell failed closed: ${message}` : `Sandboxed shell failed closed: ${message}`);
      } finally {
        if (updateTimer !== undefined) clearTimeout(updateTimer);
        acceptingOutput = false;
        core.invalidateRepositoryObservation();
        clearAtelierPhase(ctx, { reason: signal?.aborted === true ? "interrupted" : "completed" });
      }
    },
  };
}
