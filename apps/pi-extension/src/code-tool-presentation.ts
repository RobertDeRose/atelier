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

type CodeHit = Awaited<ReturnType<AtelierCore["code"]["search"]>>[number];

function markdownLocation(hit: CodeHit): string {
  const line = hit.startLine === undefined ? "" : `:${hit.startLine}`;
  return `\`${hit.repositoryName}:${hit.path}${line}\``;
}

function markdownHit(hit: CodeHit): string {
  const preview = usefulCodePreview(hit);
  const symbol = hit.symbol?.trim();
  const title = symbol === undefined || symbol === "" ? markdownLocation(hit) : `**${symbol}** — ${markdownLocation(hit)}`;
  return preview === undefined || preview === symbol
    ? `- ${title}`
    : `- ${title}\n\n  ${preview.replaceAll("\n", "\n  ")}`;
}

export function retrievalMarkdown(retrieval: RetrievalSessionStatus): string {
  const remainingRequests = Math.max(0, retrieval.budget.providerRequestsLimit - retrieval.budget.providerRequestsUsed);
  const remainingPaths = Math.max(0, retrieval.budget.uniquePathsLimit - retrieval.budget.uniquePathsUsed);
  const decision = retrieval.lastDecision === undefined
    ? "none"
    : `${retrieval.lastDecision.kind} — ${retrieval.lastDecision.reason}`;
  return [
    "### Retrieval",
    "",
    "| field | value |",
    "|---|---|",
    `| session | \`${retrieval.sessionId}\` |`,
    `| decision | ${decision.replaceAll("|", "\\|")} |`,
    `| freshness | ${retrieval.inventory.freshness} |`,
    `| evidence | ${retrieval.inventory.evidenceCount} entries across ${retrieval.inventory.uniquePathCount} paths |`,
    `| budget | ${remainingRequests} provider requests; ${remainingPaths} unique paths remaining |`,
    `| bytes | ${retrieval.telemetry.bytesReturned}${retrieval.telemetry.truncated ? " (truncated)" : ""} |`,
  ].join("\n");
}

export function codeSearchMarkdown(query: string, results: CodeHit[], retrieval: RetrievalSessionStatus): string {
  const categories = ["definition", "source", "test", "docs", "other", "generated"] as const;
  const labels: Record<(typeof categories)[number], string> = {
    definition: "Definitions",
    source: "Source",
    test: "Tests",
    docs: "Documentation",
    other: "Other",
    generated: "Generated",
  };
  const sections = categories.flatMap((category) => {
    const items = results.filter((hit) => codeResultCategory(hit) === category);
    return items.length === 0 ? [] : [`### ${labels[category]}`, "", items.map(markdownHit).join("\n")];
  });
  return [
    `## Code search: \`${query}\``,
    "",
    ...(results.length === 0 ? ["No code matches."] : sections),
    "",
    "Use `/atelier-open PATH:LINE` or the built-in read tool to inspect a result.",
    "",
    retrievalMarkdown(retrieval),
  ].join("\n");
}

export function codeSymbolsMarkdown(query: string, results: CodeHit[], retrieval: RetrievalSessionStatus): string {
  const definitions = results.filter((hit) => codeResultCategory(hit) === "definition");
  const references = results.filter((hit) => codeResultCategory(hit) !== "definition");
  const noCall = results.length === 0 && retrieval.lastDecision?.kind === "no_provider_call"
    ? `No symbol provider call: ${retrieval.lastDecision.reason}`
    : "No symbols matched.";
  return [
    `## Symbol: \`${query}\``,
    "",
    ...(results.length === 0 ? [noCall] : []),
    ...(definitions.length === 0 ? [] : ["### Definitions", "", definitions.map(markdownHit).join("\n")]),
    ...(references.length === 0 ? [] : ["### References", "", references.map(markdownHit).join("\n")]),
    "",
    "Use `/atelier-open PATH:LINE` or the built-in read tool to inspect a result.",
    "",
    retrievalMarkdown(retrieval),
  ].join("\n");
}
