import { nowIso } from "../util/ids.ts";
import type {
  CanonicalRetrievalQuery,
  CompactHitValue,
  CompactRelationshipValue,
  RetrievalInvalidation,
  RetrievalReuseDecision,
} from "./retrieval.ts";
import type {
  AtelierRetrievalObservation,
  CodeChunk,
  CodeProviderStatus,
  CodeProvenance,
  CodeRelationship,
  CodeSearchHit,
  CodeWorkspace,
} from "./types.ts";

export function uniqueBindings(bindings: CanonicalRetrievalQuery["binding"][]): CanonicalRetrievalQuery["binding"][] {
  const values = new Map(bindings.map((binding) => [JSON.stringify(binding), binding]));
  return [...values.values()];
}

export function relationshipEvidenceDigest(relationship: CodeRelationship): string {
  return `relationship:${relationship.kind}:${referenceKey(relationship.source)}:${referenceKey(relationship.target)}`;
}

export function createInvalidation(reason: string, affectedQueryDigests: string[]): RetrievalInvalidation {
  const kind: RetrievalInvalidation["kind"] = reason.includes("workspace")
    ? "workspace_scope"
    : reason.includes("provider identity")
      ? "provider_identity"
      : reason.includes("index revision")
        ? "index_revision"
        : "repository_revision";
  return { kind, affectedQueryDigests, reason, invalidatedAt: nowIso() };
}

export function compactHitValue(value: CompactHitValue): CompactHitValue {
  const { summary, preview, atelierObservations, ...rest } = value;
  return {
    ...rest,
    ...(summary === undefined ? {} : { summary: compactText(summary, 1_000) }),
    ...(preview === undefined ? {} : { preview: compactText(preview, 2_000) }),
    ...(atelierObservations === undefined ? {} : {
      atelierObservations: atelierObservations.slice(-8).map((item) => ({
        ...item,
        reason: compactText(item.reason, 500),
      })),
    }),
  };
}

export function compactRelationshipValue(value: CompactRelationshipValue): CompactRelationshipValue {
  const { label, atelierObservations, ...rest } = value;
  return {
    ...rest,
    ...(label === undefined ? {} : { label: compactText(label, 1_000) }),
    ...(atelierObservations === undefined ? {} : {
      atelierObservations: atelierObservations.slice(-8).map((item) => ({
        ...item,
        reason: compactText(item.reason, 500),
      })),
    }),
  };
}

export function compactProvenance(provenance: CodeProvenance): CodeProvenance {
  return {
    ...provenance,
    query: compactText(provenance.query, 500),
    requestedFilters: compactRecord(provenance.requestedFilters, 2_000),
    enforcedFilters: provenance.enforcedFilters.slice(0, 32).map((item) => compactText(item, 200)),
    postProcessing: provenance.postProcessing.slice(0, 32).map((item) => compactText(item, 200)),
    ...(provenance.warnings === undefined ? {} : { warnings: provenance.warnings.slice(0, 8).map((item) => compactText(item, 500)) }),
  };
}

export function compactRecord(value: Record<string, unknown>, maximumBytes: number): Record<string, unknown> {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= maximumBytes ? value : { truncated: true };
  } catch {
    return { corrupted: true };
  }
}

export function compactText(value: string, maximumBytes: number): string {
  return truncateUtf8(value, maximumBytes).value;
}

export function boundedLimit(value: number | undefined, maximum: number): number {
  return Math.min(Number.isInteger(value) && (value ?? 0) > 0 ? value! : maximum, maximum);
}

export function selectedRepositories(workspace: CodeWorkspace, repositoryIds: string[] | undefined) {
  if (repositoryIds === undefined || repositoryIds.length === 0) return workspace.repositories;
  const selected = new Set(repositoryIds);
  const repositories = workspace.repositories.filter((repository) => selected.has(repository.id));
  if (repositories.length !== selected.size) {
    const missing = [...selected].filter((id) => !repositories.some((repository) => repository.id === id));
    throw new Error(`Unknown repository scope: ${missing.join(", ")}`);
  }
  return repositories;
}

export function statusAllowsReuse(status: CodeProviderStatus): boolean {
  return status.available
    && status.healthy
    && status.indexRevision !== undefined
    && status.indexState === "ready"
    && status.degraded !== true;
}

export function cacheFreshness(status: CodeProviderStatus) {
  return statusAllowsReuse(status)
    ? "current" as const
    : "unknown" as const;
}

export function sameBinding(left: CanonicalRetrievalQuery, right: CanonicalRetrievalQuery): boolean {
  return JSON.stringify(left.binding) === JSON.stringify(right.binding);
}

export function overlappingBindingDifference(
  previous: CanonicalRetrievalQuery,
  current: CanonicalRetrievalQuery,
): string | undefined {
  if (JSON.stringify(previous.binding.provider) !== JSON.stringify(current.binding.provider)) {
    return "provider identity changed; overlapping cached evidence was invalidated";
  }
  if (previous.binding.indexRevision !== current.binding.indexRevision) {
    return "provider index revision changed; overlapping cached evidence was invalidated";
  }
  const currentRepositories = new Map(current.binding.repositories.map((repository) => [repository.repositoryId, repository]));
  const changedRepository = previous.binding.repositories.find((repository) => {
    const currentRepository = currentRepositories.get(repository.repositoryId);
    return currentRepository !== undefined && JSON.stringify(repository) !== JSON.stringify(currentRepository);
  });
  return changedRepository === undefined
    ? undefined
    : `repository revision changed for ${changedRepository.repositoryId}; overlapping cached evidence was invalidated`;
}

export function bindingDifference(previous: CanonicalRetrievalQuery, current: CanonicalRetrievalQuery): string {
  if (previous.binding.workspaceId !== current.binding.workspaceId) return "workspace scope changed; cached evidence was invalidated";
  if (JSON.stringify(previous.binding.provider) !== JSON.stringify(current.binding.provider)) return "provider identity changed; cached evidence was invalidated";
  if (previous.binding.indexRevision !== current.binding.indexRevision) return "provider index revision changed; cached evidence was invalidated";
  if (JSON.stringify(previous.binding.repositories) !== JSON.stringify(current.binding.repositories)) return "repository revision changed; cached evidence was invalidated";
  return "canonical revision binding changed; cached evidence was invalidated";
}

export function inventoryPathKey(workspaceId: string, repositoryId: string, path: string): string {
  return `${workspaceId}:${repositoryId}:${normalizePath(path)}`;
}

export function referenceKey(reference: CodeSearchHit["reference"]): string {
  return `${reference.provider}:${reference.repositoryId}:${reference.opaqueId}`;
}

export function chunkKey(hit: CodeSearchHit): string {
  return `${hit.repositoryId}:${normalizePath(hit.path)}:${hit.startLine ?? ""}:${hit.endLine ?? ""}:${referenceKey(hit.reference)}`;
}

export function symbolKey(hit: CodeSearchHit): string | undefined {
  return hit.symbol === undefined
    ? undefined
    : `${hit.repositoryId}:${normalizePath(hit.path)}:${hit.startLine ?? ""}:${hit.endLine ?? ""}:${hit.symbol}`;
}

export function mergeHits(current: CodeSearchHit, previous: CodeSearchHit, queryDigest: string): CodeSearchHit {
  const provenanceObservations = uniqueProvenance([
    current.provenance,
    ...(current.provenanceObservations ?? []),
    previous.provenance,
    ...(previous.provenanceObservations ?? []),
  ]);
  return {
    ...current,
    retrievalMethods: [...new Set([...current.retrievalMethods, ...previous.retrievalMethods])],
    provenanceObservations,
    atelierObservations: [
      ...(previous.atelierObservations ?? []),
      ...(current.atelierObservations ?? []),
      observation("deduplicated", queryDigest, `Merged repeated path ${current.repositoryId}:${current.path}.`),
    ],
  };
}

export function uniqueProvenance(values: CodeSearchHit["provenance"][]): CodeSearchHit["provenance"][] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify([value.provider, value.workspaceId, value.repositoryId, value.query, value.retrievedAt, value.indexedRevision, value.currentRevision]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function observeHit(hit: CodeSearchHit, queryDigest: string, decision: RetrievalReuseDecision): CodeSearchHit {
  return {
    ...hit,
    atelierObservations: [
      ...(hit.atelierObservations ?? []),
      observation(decision.kind, queryDigest, decision.reason),
    ],
  };
}

export function observeChunk(chunk: CodeChunk, queryDigest: string, decision: RetrievalReuseDecision): CodeChunk {
  return {
    ...chunk,
    atelierObservations: [
      ...(chunk.atelierObservations ?? []),
      observation(decision.kind, queryDigest, decision.reason),
    ],
  };
}

export function observeRelationship(relationship: CodeRelationship, queryDigest: string, decision: RetrievalReuseDecision): CodeRelationship {
  return {
    ...relationship,
    atelierObservations: [
      ...(relationship.atelierObservations ?? []),
      observation(decision.kind, queryDigest, decision.reason),
    ],
  };
}

export function observation(kind: AtelierRetrievalObservation["kind"], queryDigest: string, reason: string): AtelierRetrievalObservation {
  return { kind, queryDigest, reason, observedAt: nowIso() };
}

export function pathCandidates(text: string): string[] {
  const tokens = text.match(/[A-Za-z0-9_.@/-]+/g) ?? [];
  return [...new Set(tokens.map(normalizePath).filter((token) => {
    const name = token.split("/").at(-1) ?? token;
    return token.includes("/") && /\.[A-Za-z0-9]{1,8}$/.test(name);
  }))];
}

export function isIdentifier(text: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(text);
}

const NON_SYMBOL_IDENTIFIERS = new Set([
  "code", "file", "implementation", "path", "plan", "produce", "provider", "repository", "state", "task", "test", "working",
]);

export function identifierCandidates(text: string, explicit: string[] | undefined): string[] {
  const quoted = [...text.matchAll(/`([^`]+)`/g)].flatMap((match) => match[1] === undefined ? [] : [match[1]]);
  const quotedIdentifiers = new Set(quoted);
  const explicitIdentifiers = [...(explicit ?? []), ...quoted]
    .filter((value) => isIdentifier(value)
      && !value.includes("/")
      && !value.includes(".")
      && !NON_SYMBOL_IDENTIFIERS.has(value.toLowerCase())
      && (quotedIdentifiers.has(value) || isCodeShapedIdentifier(value)));
  const inferred = (text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).filter(isCodeShapedIdentifier);
  return [...new Set([...explicitIdentifiers, ...inferred])];
}

export function isCodeShapedIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
    && (value.includes("_")
      || value.includes("$")
      || /[a-z0-9][A-Z]/.test(value)
      || /^[A-Z][A-Z0-9_]{2,}$/.test(value));
}

export function retrievalBindingKey(query: CanonicalRetrievalQuery): string {
  return JSON.stringify(query.binding);
}

export function scopedSymbolKey(query: CanonicalRetrievalQuery, symbol: string): string {
  return `${retrievalBindingKey(query)}\0${symbol}`;
}

export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value) <= maxBytes) return { value, truncated: false };
  if (maxBytes <= 0) return { value: "", truncated: true };
  const marker = "…[truncated]";
  const markerBytes = Buffer.byteLength(marker);
  if (maxBytes < markerBytes) return { value: utf8Prefix(value, maxBytes), truncated: true };
  return { value: `${utf8Prefix(value, maxBytes - markerBytes)}${marker}`, truncated: true };
}

export function utf8Prefix(value: string, maxBytes: number): string {
  let result = value;
  while (result && Buffer.byteLength(result) > maxBytes) result = result.slice(0, -1);
  return result;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
