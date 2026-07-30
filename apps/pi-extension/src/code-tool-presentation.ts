import {
  type AtelierCore,
  type RetrievalSessionStatus,
  codeResultCategory,
  usefulCodePreview,
} from "../../../packages/core/src/index.ts";

const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

type ToolSchema = Record<string | symbol, unknown>;

export function stringSchema(description: string, values?: readonly string[]): ToolSchema {
  return {
    [TYPEBOX_KIND]: "String",
    type: "string",
    description,
    ...(values === undefined ? {} : { enum: [...values] }),
  };
}

export function integerSchema(description: string, minimum: number, maximum: number): ToolSchema {
  return {
    [TYPEBOX_KIND]: "Integer",
    type: "integer",
    description,
    minimum,
    maximum,
  };
}

export function objectSchema(properties: Record<string, ToolSchema>, required: string[] = []): ToolSchema {
  return {
    [TYPEBOX_KIND]: "Object",
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function codeHitText(hit: Awaited<ReturnType<AtelierCore["code"]["search"]>>[number]): string {
  const location = `${hit.repositoryName}:${hit.path}${hit.startLine === undefined ? "" : `:${hit.startLine}`}`;
  const symbol = hit.symbol === undefined ? "" : ` · ${hit.symbol}`;
  const score = hit.providerScore === undefined ? "" : ` · score ${hit.providerScore.toFixed(3)}`;
  const preview = hit.preview?.trim();
  return `${hit.rank}. ${location}${symbol}${score}${preview ? `\n${preview}` : ""}`;
}

export function conciseProviderDetail(detail: string | undefined): string[] {
  const summary = detail?.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  return summary === undefined ? [] : [`Detail: ${summary}`];
}

export function retrievalText(retrieval: RetrievalSessionStatus): string {
  const remainingRequests = Math.max(0, retrieval.budget.providerRequestsLimit - retrieval.budget.providerRequestsUsed);
  const remainingPaths = Math.max(0, retrieval.budget.uniquePathsLimit - retrieval.budget.uniquePathsUsed);
  const inventory = retrieval.inventory.knownPaths.length === 0
    ? "empty"
    : retrieval.inventory.knownPaths.join(", ");
  return [
    `Retrieval session: ${retrieval.sessionId}`,
    `Decision: ${retrieval.lastDecision?.kind ?? "none"}${retrieval.lastDecision === undefined ? "" : ` — ${retrieval.lastDecision.reason}`}`,
    `Inventory: ${retrieval.inventory.evidenceCount} compact entries · ${retrieval.inventory.uniquePathCount} unique paths · freshness ${retrieval.inventory.freshness}`,
    `Known paths: ${inventory}`,
    `Resolved symbols: ${retrieval.inventory.resolvedSymbols.join(", ") || "none"}`,
    `Unresolved symbols: ${retrieval.inventory.unresolvedSymbols.join(", ") || "none"}`,
    `Remaining provider requests: ${remainingRequests}; remaining unique paths: ${remainingPaths}`,
    `Deduplication: ${retrieval.telemetry.duplicateResultsRemoved} results · ${retrieval.telemetry.duplicatePathsRemoved} paths · ${retrieval.telemetry.duplicateReferencesRemoved} references removed`,
    `Bytes returned: ${retrieval.telemetry.bytesReturned}; truncated: ${retrieval.telemetry.truncated}`,
  ].join("\n");
}

export function codeToolError(
  error: unknown,
  core?: AtelierCore,
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  const message = error instanceof Error ? error.message : String(error);
  const retrieval = core?.code.retrievalStatus();
  return {
    content: [{
      type: "text",
      text: `Atelier code intelligence failed: ${message}`
        + (retrieval === undefined ? "" : `\n\n${retrievalText(retrieval)}`),
    }],
    details: {
      error: message,
      ...(retrieval === undefined ? {} : { retrieval }),
    },
  };
}
