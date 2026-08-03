export interface PlanTaskMetadataBlock {
  startIndex: number;
  endIndex: number;
  metadata?: Record<string, unknown>;
  error?: string;
}

function parseMetadataJson(raw: string): Pick<PlanTaskMetadataBlock, "metadata" | "error"> {
  const text = raw.trim();
  if (text.length === 0) return { error: "Task metadata comment does not contain a JSON object." };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Task metadata must be a JSON object." };
    }
    return { metadata: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      error: `Task metadata must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Parse either the legacy one-line comment or the canonical multiline block. */
export function parseTaskMetadataBlock(
  lines: readonly string[],
  startIndex: number,
): PlanTaskMetadataBlock | undefined {
  const line = lines[startIndex] ?? "";
  const start = /^\s*<!--\s*atlr:task\b([\s\S]*)$/.exec(line);
  if (start === null) return undefined;

  const firstRemainder = start[1] ?? "";
  const inlineClose = firstRemainder.indexOf("-->");
  if (inlineClose !== -1) {
    const trailing = firstRemainder.slice(inlineClose + 3).trim();
    if (trailing.length > 0) {
      return {
        startIndex,
        endIndex: startIndex,
        error: "Unexpected text follows the task metadata comment.",
      };
    }
    return {
      startIndex,
      endIndex: startIndex,
      ...parseMetadataJson(firstRemainder.slice(0, inlineClose)),
    };
  }

  const body: string[] = [];
  if (firstRemainder.trim().length > 0) body.push(firstRemainder);
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const candidate = lines[index] ?? "";
    const close = candidate.indexOf("-->");
    if (close === -1) {
      body.push(candidate);
      continue;
    }
    const trailing = candidate.slice(close + 3).trim();
    if (trailing.length > 0) {
      return {
        startIndex,
        endIndex: index,
        error: "Unexpected text follows the task metadata comment.",
      };
    }
    const beforeClose = candidate.slice(0, close);
    if (beforeClose.trim().length > 0) body.push(beforeClose);
    return {
      startIndex,
      endIndex: index,
      ...parseMetadataJson(body.join("\n")),
    };
  }

  return {
    startIndex,
    endIndex: lines.length - 1,
    error: "Task metadata comment is not terminated with -->.",
  };
}

export function findTaskMetadataBlock(lines: readonly string[]): PlanTaskMetadataBlock | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const block = parseTaskMetadataBlock(lines, index);
    if (block !== undefined) return block;
  }
  return undefined;
}

export function formatTaskMetadataComment(metadata: Record<string, unknown>): string[] {
  return [
    "<!-- atlr:task",
    ...JSON.stringify(metadata, null, 2).split("\n"),
    "-->",
  ];
}

/** Canonicalize all valid task metadata comments while preserving other text. */
export function formatPlanTaskMetadataText(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const block = parseTaskMetadataBlock(lines, index);
    if (block === undefined) {
      output.push(lines[index] ?? "");
      continue;
    }
    if (block.metadata === undefined) {
      output.push(...lines.slice(block.startIndex, block.endIndex + 1));
    } else {
      output.push(...formatTaskMetadataComment(block.metadata));
    }
    index = block.endIndex;
  }
  const result = output.join("\n");
  return text.endsWith("\n") && !result.endsWith("\n") ? `${result}\n` : result;
}
