export type ToolExecutionOutcome = "succeeded" | "failed" | "interrupted";

interface ToolResultLike {
  toolName?: string;
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

function textContent(event: ToolResultLike): string {
  return (event.content ?? [])
    .filter((item): item is { type?: string; text: string } => typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function structuredInterruption(details: unknown): boolean {
  if (details === null || typeof details !== "object") return false;
  const value = details as Record<string, unknown>;
  return value.interrupted === true
    || value.aborted === true
    || value.cancelled === true
    || value.canceled === true
    || value.name === "AbortError"
    || value.code === "ABORT_ERR";
}

/**
 * Classify a Pi tool result without interpreting arbitrary process output as
 * cancellation metadata. Pi 0.82 exposes the current AbortSignal but does not
 * add a general interrupted flag to every tool result. Its built-in Bash tool
 * uses the exact terminal status line `Command aborted` for that case.
 */
export function toolExecutionOutcome(
  event: ToolResultLike,
  currentSignal?: AbortSignal,
): { status: ToolExecutionOutcome; error?: string } {
  if (event.isError !== true) return { status: "succeeded" };

  const text = textContent(event);
  const bashAborted = event.toolName === "bash"
    && /(?:^|\n)Command aborted\s*$/.test(text.trimEnd());
  const interrupted = currentSignal?.aborted === true
    || structuredInterruption(event.details)
    || bashAborted;

  return {
    status: interrupted ? "interrupted" : "failed",
    error: text || "Tool execution failed.",
  };
}
