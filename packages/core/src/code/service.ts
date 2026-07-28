import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import { newId, nowIso } from "../util/ids.ts";
import {
  canonicalizeRetrievalQuery,
  canonicalQueryRequestDigest,
  decideCanonicalQueryReuse,
  type CanonicalQueryInput,
} from "./canonical-query.ts";
import type { CodeProvider } from "./provider.ts";
import type { CodeProviderRegistry } from "./registry.ts";
import {
  bindingDifference,
  boundedLimit,
  cacheFreshness,
  chunkKey,
  compactHitValue,
  compactProvenance,
  compactRelationshipValue,
  createInvalidation,
  errorMessage,
  identifierCandidates,
  inventoryPathKey,
  isIdentifier,
  mergeHits,
  normalizePath,
  observeChunk,
  observeHit,
  observeRelationship,
  overlappingBindingDifference,
  pathCandidates,
  referenceKey,
  relationshipEvidenceDigest,
  retrievalBindingKey,
  sameBinding,
  scopedSymbolKey,
  selectedRepositories,
  statusAllowsReuse,
  symbolKey,
  truncateUtf8,
  uniqueBindings,
  uniqueProvenance,
} from "./service-support.ts";
import type {
  CachedQueryCoverage,
  CanonicalRetrievalQuery,
  CompactHitValue,
  CompactRelationshipValue,
  PersistedRetrievalCheckpoint,
  PersistedRetrievalEvidence,
  RetrievalBudgetSnapshot,
  RetrievalDecisionRecord,
  RetrievalDiagnostic,
  RetrievalInvalidation,
  RetrievalPersistenceLimits,
  RetrievalReuseDecision,
  RetrievalSessionStatus,
  RetrievalTelemetry,
} from "./retrieval.ts";
import type {
  AtelierRetrievalObservation,
  CodeChunk,
  CodeIndexState,
  CodeProviderStatus,
  CodeProvenance,
  CodeRelationship,
  CodeRelationshipQuery,
  CodeSearchFocus,
  CodeSearchHit,
  CodeSearchMode,
  CodeWorkspace,
} from "./types.ts";

export interface CodeIndexCoordinatorStatus {
  state: CodeIndexState;
  active: boolean;
  provider?: string;
  workspaceId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface CodeServiceLimits {
  maxResults: number;
  maxPreviewBytes: number;
  maxChunkBytes: number;
  maxFetches: number;
  maxTotalBytes: number;
  maxProviderRequests: number;
  maxUniquePaths: number;
  maxEvidenceEntries: number;
}

interface CachedHitQuery extends CachedQueryCoverage {
  requestDigest: string;
  hits: CodeSearchHit[];
}

interface CachedRelationshipQuery extends CachedQueryCoverage {
  requestDigest: string;
  relationships: CodeRelationship[];
}

interface InventoryHit {
  hit: CodeSearchHit;
  sourceDigests: Set<string>;
}

interface ReferenceContext {
  query: CanonicalRetrievalQuery;
  workspace: CodeWorkspace;
}

interface CachedChunk {
  chunk: CodeChunk;
  queryDigest: string;
}

interface BoundedHits {
  hits: CodeSearchHit[];
  truncated: boolean;
}

interface BoundedRelationships {
  relationships: CodeRelationship[];
  truncated: boolean;
}

type CodeIndexStatusListener = (status: CodeIndexCoordinatorStatus) => void;

const DEFAULT_PERSISTENCE_LIMITS: RetrievalPersistenceLimits = {
  maxRetainedSessions: 4,
  maxEntries: 256,
  maxBytes: 256_000,
};

const DEFAULT_LIMITS: CodeServiceLimits = {
  maxResults: 10,
  maxPreviewBytes: 2_000,
  maxChunkBytes: 16_000,
  maxFetches: 8,
  maxTotalBytes: 64_000,
  maxProviderRequests: 8,
  maxUniquePaths: 32,
  maxEvidenceEntries: 64,
};

export class CodeService {
  private readonly registry: CodeProviderRegistry;
  private readonly ledger: SqliteLedger;
  private readonly limits: CodeServiceLimits;
  private readonly persistenceLimits: RetrievalPersistenceLimits;
  private sessionId: string;
  private sessionStartedAt: string;
  private fetched = 0;
  private retrievedBytes = 0;
  private providerRequests = 0;
  private activeIndex: Promise<CodeIndexState> | undefined;
  private indexStatus: CodeIndexCoordinatorStatus = { state: "unknown", active: false };
  private readonly indexListeners = new Set<CodeIndexStatusListener>();
  private readonly hitQueries = new Map<string, CachedHitQuery>();
  private readonly relationshipQueries = new Map<string, CachedRelationshipQuery>();
  private readonly inventoryHits = new Map<string, InventoryHit>();
  private readonly referenceContexts = new Map<string, ReferenceContext>();
  private readonly chunks = new Map<string, CachedChunk>();
  private readonly pathKeys = new Set<string>();
  private readonly evidenceEntryKeys = new Set<string>();
  private readonly referenceKeys = new Set<string>();
  private readonly symbolKeys = new Set<string>();
  private readonly unresolvedSymbolKeys = new Set<string>();
  private readonly chunkKeys = new Set<string>();
  private diagnostics: RetrievalDiagnostic[] = [];
  private decisions: RetrievalDecisionRecord[] = [];
  private invalidations: RetrievalInvalidation[] = [];
  private lastDecision: RetrievalReuseDecision | undefined;
  private pendingBindingInvalidationDigest: string | undefined;
  private telemetry: RetrievalTelemetry = emptyTelemetry();

  constructor(
    registry: CodeProviderRegistry,
    ledger: SqliteLedger,
    limits: Partial<CodeServiceLimits> = {},
    sessionId = newId("retrieval-session"),
    persistenceLimits: Partial<RetrievalPersistenceLimits> = {},
  ) {
    this.registry = registry;
    this.ledger = ledger;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.persistenceLimits = { ...DEFAULT_PERSISTENCE_LIMITS, ...persistenceLimits };
    validateLimits(this.limits);
    validatePersistenceLimits(this.persistenceLimits);
    this.sessionId = sessionId;
    this.sessionStartedAt = nowIso();
    this.hydrateCheckpoint(this.ledger.loadRetrievalCheckpoint(sessionId));
  }

  providers(workspace?: CodeWorkspace) { return this.registry.statuses(workspace); }

  async status(provider?: string, workspace?: CodeWorkspace) {
    const selected = this.registry.get(provider);
    if (this.activeIndex !== undefined && this.indexStatus.provider === selected.name) {
      return {
        identity: { name: selected.name, instanceId: `${selected.name}-index-coordinator` },
        available: true,
        healthy: true,
        capabilities: [],
        indexState: "building" as const,
        detail: "Atelier background indexing is active. Searches and index requests will join this operation.",
      };
    }
    return selected.status(workspace);
  }

  beginRetrievalSession(sessionId = newId("retrieval-session")): string {
    this.sessionId = sessionId;
    this.sessionStartedAt = nowIso();
    this.fetched = 0;
    this.retrievedBytes = 0;
    this.providerRequests = 0;
    this.hitQueries.clear();
    this.relationshipQueries.clear();
    this.inventoryHits.clear();
    this.referenceContexts.clear();
    this.chunks.clear();
    this.pathKeys.clear();
    this.evidenceEntryKeys.clear();
    this.referenceKeys.clear();
    this.symbolKeys.clear();
    this.unresolvedSymbolKeys.clear();
    this.chunkKeys.clear();
    this.diagnostics = [];
    this.decisions = [];
    this.invalidations = [];
    this.lastDecision = undefined;
    this.pendingBindingInvalidationDigest = undefined;
    this.telemetry = emptyTelemetry();
    this.persistCheckpoint();
    return sessionId;
  }

  endRetrievalSession(): string {
    this.persistCheckpoint("closed");
    return this.sessionId;
  }

  retrievalStatus(): RetrievalSessionStatus {
    const budget = this.budgetSnapshot();
    const activeHits = [...this.inventoryHits.values()]
      .filter((entry) => [...entry.sourceDigests].some((digest) => this.hitQueries.has(digest)))
      .map((entry) => entry.hit);
    const storage = this.ledger.retrievalStorageStats();
    const freshness = activeHits.length === 0
      ? "unknown" as const
      : activeHits.every((hit) => hit.provenance.freshness === undefined || hit.provenance.freshness === "current")
        ? "current" as const
        : "possibly_stale" as const;
    return {
      sessionId: this.sessionId,
      ...(this.lastDecision === undefined ? {} : { lastDecision: { ...this.lastDecision } }),
      budget,
      telemetry: { ...this.telemetry },
      persistence: {
        retainedSessionsUsed: storage.sessions,
        retainedSessionsLimit: this.persistenceLimits.maxRetainedSessions,
        entriesUsed: storage.entries,
        entriesLimit: this.persistenceLimits.maxEntries,
        bytesUsed: storage.bytes,
        bytesLimit: this.persistenceLimits.maxBytes,
      },
      inventory: {
        sessionId: this.sessionId,
        queryCount: this.hitQueries.size + this.relationshipQueries.size,
        semanticDiscoveryComplete: [...this.hitQueries.values()].some((cached) =>
          cached.query.operation === "search"
          && cached.complete
          && !cached.truncated
          && !cached.degraded
          && cached.freshness === "current"),
        evidenceCount: this.evidenceEntryKeys.size,
        uniquePathCount: this.pathKeys.size,
        resolvedSymbols: [...new Set(activeHits.flatMap((hit) => hit.symbol === undefined ? [] : [hit.symbol]))].sort(),
        unresolvedSymbols: [...new Set([...this.unresolvedSymbolKeys].map((key) => key.slice(key.lastIndexOf("\0") + 1)))].sort(),
        knownPaths: [...new Set(activeHits.map((hit) => hit.path))].sort(),
        freshness,
        budget,
      },
      diagnostics: this.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      invalidations: this.invalidations.map((record) => ({ ...record, affectedQueryDigests: [...record.affectedQueryDigests] })),
      decisions: this.decisions.map((record) => ({ ...record, decision: { ...record.decision } })),
      evidence: this.compactEvidence(),
      bindings: uniqueBindings([
        ...this.hitQueries.values(),
        ...this.relationshipQueries.values(),
      ].map((entry) => entry.query.binding)),
      semanticDiscoveryBindings: uniqueBindings([...this.hitQueries.values()]
        .filter((cached) => cached.query.operation === "search"
          && cached.complete
          && !cached.truncated
          && !cached.degraded
          && cached.freshness === "current")
        .map((cached) => cached.query.binding)),
      unresolvedSymbolScopes: [...this.unresolvedSymbolKeys].flatMap((key) => {
        const separator = key.lastIndexOf("\0");
        if (separator < 0) return [];
        try {
          const binding = JSON.parse(key.slice(0, separator)) as CanonicalRetrievalQuery["binding"];
          return [{
            workspaceId: binding.workspaceId,
            repositoryIds: binding.repositories.map((repository) => repository.repositoryId),
            symbol: key.slice(separator + 1),
          }];
        } catch {
          return [];
        }
      }),
    };
  }

  indexingStatus(): CodeIndexCoordinatorStatus {
    return { ...this.indexStatus };
  }

  onIndexStatus(listener: CodeIndexStatusListener): () => void {
    this.indexListeners.add(listener);
    listener(this.indexingStatus());
    return () => this.indexListeners.delete(listener);
  }

  async ensureIndex(workspace: CodeWorkspace, provider?: string) {
    if (this.activeIndex !== undefined) return this.activeIndex;
    const selected = this.registry.get(provider);
    this.setIndexStatus({
      state: "building",
      active: true,
      provider: selected.name,
      workspaceId: workspace.id,
      startedAt: nowIso(),
    });
    const operation = (async () => {
      try {
        const state = await selected.ensureIndex(workspace);
        const { error: _previousError, ...statusWithoutError } = this.indexStatus;
        this.setIndexStatus({ ...statusWithoutError, state, active: false, completedAt: nowIso() });
        this.ledger.append({ kind: "code.index_completed", actor: "system", payload: { provider: selected.name, workspaceId: workspace.id, state } });
        return state;
      } catch (error) {
        const message = errorMessage(error);
        this.setIndexStatus({ ...this.indexStatus, state: "failed", active: false, completedAt: nowIso(), error: message });
        this.ledger.append({ kind: "code.index_failed", actor: "system", payload: { provider: selected.name, workspaceId: workspace.id, error: message } });
        throw error;
      } finally {
        this.activeIndex = undefined;
      }
    })();
    this.activeIndex = operation;
    this.ledger.append({ kind: "code.index_requested", actor: "system", payload: { provider: selected.name, workspaceId: workspace.id } });
    return operation;
  }

  async search(options: {
    workspace: CodeWorkspace;
    text: string;
    mode?: CodeSearchMode;
    focus?: CodeSearchFocus;
    literalHints?: string[];
    repositoryIds?: string[];
    limit?: number;
    provider?: string;
  }): Promise<CodeSearchHit[]> {
    await this.waitForActiveIndex();
    const selected = this.registry.get(options.provider);
    const status = await selected.status(options.workspace);
    const limit = boundedLimit(options.limit, this.limits.maxResults);
    const query = this.canonicalQuery({
      operation: "search",
      text: options.text,
      selected,
      status,
      workspace: options.workspace,
      ...(options.repositoryIds === undefined ? {} : { repositoryIds: options.repositoryIds }),
      mode: options.mode ?? "auto",
      focus: options.focus ?? "auto",
      filters: {
        ...(options.repositoryIds === undefined ? {} : { repositoryIds: options.repositoryIds }),
        ...(options.literalHints === undefined ? {} : { literalHints: options.literalHints }),
        includeTests: true,
        includeGenerated: false,
      },
      requestedLimit: limit,
    });

    const reusable = this.reuseHits(query, status);
    if (reusable !== undefined) return this.returnHits(reusable, query, this.lastDecision!);

    const direct = statusAllowsReuse(status) ? this.directReadHits(query) : [];
    if (direct.length > 0) {
      this.lastDecision = { kind: "direct_read", reason: "requested path is already present in the current session inventory" };
      this.cacheHitQuery(query, direct, true, false, false, cacheFreshness(status));
      return this.returnHits(direct, query, this.lastDecision);
    }

    const overlap = statusAllowsReuse(status) ? this.overlapHits(query) : [];
    if (overlap.length > 0) {
      this.telemetry.overlapReuses += 1;
      this.lastDecision = { kind: "overlap_reuse", reason: "current scoped inventory explicitly resolves the requested symbol" };
      this.cacheHitQuery(query, overlap, true, false, false, cacheFreshness(status));
      return this.returnHits(overlap, query, this.lastDecision);
    }

    if (!status.capabilities.some((capability) => capability === "search.lexical" || capability === "search.semantic" || capability === "search.hybrid")) {
      this.lastDecision = { kind: "unsupported", reason: `Code provider ${selected.name} does not advertise a supported search capability.` };
      this.recordDecision(query, this.lastDecision);
      this.persistCheckpoint();
      throw new Error(this.lastDecision.reason);
    }
    this.prepareProviderCall(query);
    let results: CodeSearchHit[];
    try {
      results = await selected.search({
        workspace: options.workspace,
        text: options.text,
        mode: options.mode ?? "auto",
        focus: options.focus ?? "auto",
        ...(options.literalHints === undefined ? {} : { literalHints: options.literalHints }),
        ...(options.repositoryIds === undefined ? {} : { repositoryIds: options.repositoryIds }),
        limit,
        includeTests: true,
        includeGenerated: false,
      });
    } catch (error) {
      this.recordProviderError(query, error);
      throw error;
    }
    const degraded = status.degraded === true || results.some((hit) => hit.provenance.degraded === true);
    const bounded = this.ingestHits(query, options.workspace, results.slice(0, limit), results.length > limit);
    this.updateSymbolResolution(query, bounded.hits, options.literalHints);
    this.cacheHitQuery(query, bounded.hits, !bounded.truncated, bounded.truncated, degraded, cacheFreshness(status));
    const output = this.returnHits(bounded.hits, query, this.lastDecision!);
    this.recordCompletion("code.search_completed", selected, options.workspace, query, output.length, bounded.truncated, degraded);
    return output;
  }

  async read(reference: CodeSearchHit["reference"], provider?: string): Promise<CodeChunk> {
    const selected = this.registry.get(provider ?? reference.provider);
    const key = referenceKey(reference);
    let context = this.referenceContexts.get(key);
    if (context !== undefined) {
      const status = await selected.status(context.workspace);
      const currentQuery = this.rebindQuery(context.query, selected, status, context.workspace);
      if (currentQuery.digest !== context.query.digest || !statusAllowsReuse(status)) {
        const reason = currentQuery.digest === context.query.digest
          ? "provider status no longer permits current chunk reuse"
          : bindingDifference(context.query, currentQuery);
        this.lastDecision = { kind: "invalidated", reason };
        this.telemetry.invalidations += 1;
        this.invalidations.push(createInvalidation(reason, [context.query.digest]));
        this.chunks.delete(key);
        context = { query: currentQuery, workspace: context.workspace };
        this.referenceContexts.set(key, context);
      }
    }
    const cached = this.chunks.get(key);
    if (cached !== undefined && context !== undefined && cached.queryDigest === context.query.digest) {
      this.telemetry.cacheHits += 1;
      this.lastDecision = { kind: "exact_reuse", reason: "fetched chunk is already present at the current repository and index revisions" };
      this.recordDecision(context.query, this.lastDecision);
      this.persistCheckpoint();
      return observeChunk(cached.chunk, cached.queryDigest, this.lastDecision);
    }
    if (this.fetched >= this.limits.maxFetches) {
      this.lastDecision = { kind: "budget_denied", reason: `Code fetch budget exceeded (${this.limits.maxFetches})` };
      if (context !== undefined) this.recordDecision(context.query, this.lastDecision);
      this.persistCheckpoint();
      throw new Error(`Code fetch budget exceeded (${this.limits.maxFetches})`);
    }
    const remaining = this.limits.maxTotalBytes - this.retrievedBytes;
    if (remaining <= 0) {
      this.lastDecision = { kind: "budget_denied", reason: `Code byte budget exhausted (${this.limits.maxTotalBytes})` };
      if (context !== undefined) this.recordDecision(context.query, this.lastDecision);
      this.persistCheckpoint();
      throw new Error(`Code byte budget exhausted (${this.limits.maxTotalBytes})`);
    }
    this.requireProviderBudget(context?.query);
    this.telemetry.providerCalls += 1;
    let chunk: CodeChunk;
    try {
      chunk = await selected.read(reference);
    } catch (error) {
      const message = errorMessage(error);
      this.diagnostics.push({ code: "provider_error", level: "error", message, providerCallRequired: true });
      if (context !== undefined) this.recordDecision(context.query, this.lastDecision ?? { kind: "provider_call", reason: "provider fetch failed" });
      this.persistCheckpoint();
      throw error;
    }
    const bounded = truncateUtf8(chunk.content, Math.min(this.limits.maxChunkBytes, remaining));
    const result = { ...chunk, content: bounded.value };
    this.fetched += 1;
    this.retrievedBytes += Buffer.byteLength(result.content);
    this.telemetry.bytesReturned += Buffer.byteLength(result.content);
    this.telemetry.truncated ||= bounded.truncated;
    if (bounded.truncated) this.noteTruncation("chunk_byte_budget_truncated", `Fetched chunk ${reference.repositoryId}:${reference.path} was truncated by the session byte budget.`);
    this.lastDecision = this.lastDecision?.kind === "invalidated"
      ? this.lastDecision
      : { kind: "provider_call", reason: "chunk was not present in the current session inventory" };
    if (!bounded.truncated && context !== undefined) {
      this.chunks.set(key, { chunk: result, queryDigest: context.query.digest });
    }
    if (context !== undefined) this.recordDecision(context.query, this.lastDecision);
    this.persistCheckpoint();
    return observeChunk(result, context?.query.digest ?? key, this.lastDecision);
  }

  async symbols(options: {
    workspace: CodeWorkspace;
    text: string;
    repositoryIds?: string[];
    limit?: number;
    provider?: string;
  }): Promise<CodeSearchHit[]> {
    await this.waitForActiveIndex();
    const selected = this.registry.get(options.provider);
    const status = await selected.status(options.workspace);
    const limit = boundedLimit(options.limit, this.limits.maxResults);
    const query = this.canonicalQuery({
      operation: "symbols",
      text: options.text,
      selected,
      status,
      workspace: options.workspace,
      ...(options.repositoryIds === undefined ? {} : { repositoryIds: options.repositoryIds }),
      filters: options.repositoryIds === undefined ? {} : { repositoryIds: options.repositoryIds },
      requestedLimit: limit,
    });
    if (
      status.available === false
      || status.healthy === false
      || status.indexState === "stale"
      || status.indexState === "failed"
      || status.degraded === true
    ) {
      const reason = `Code provider ${selected.name} is unavailable, unhealthy, stale, failed, or degraded; current symbol evidence was invalidated.`;
      this.evictBinding(query);
      this.lastDecision = { kind: "invalidated", reason };
      this.telemetry.invalidations += 1;
      this.invalidations.push(createInvalidation(reason, [query.digest]));
      this.diagnostics.push({ code: "provider_unavailable", level: "error", message: reason, queryDigest: query.digest, providerCallRequired: false });
      this.recordDecision(query, this.lastDecision);
      this.persistCheckpoint();
      throw new Error(reason);
    }
    const reusable = this.reuseHits(query, status);
    if (reusable !== undefined) return this.returnHits(reusable, query, this.lastDecision!);
    const resolved = statusAllowsReuse(status)
      ? this.currentInventoryHits(query, (hit) => hit.symbol === query.normalizedText)
      : [];
    if (resolved.length > 0) {
      this.telemetry.overlapReuses += 1;
      this.lastDecision = { kind: "overlap_reuse", reason: "current scoped inventory already resolves this identifier; no symbol provider call is needed" };
      this.cacheHitQuery(query, resolved, true, false, false, cacheFreshness(status));
      return this.returnHits(resolved, query, this.lastDecision);
    }
    const unresolvedKey = scopedSymbolKey(query, query.normalizedText);
    const discoveryComplete = this.semanticDiscoveryComplete(query);
    if (!discoveryComplete || !this.unresolvedSymbolKeys.has(unresolvedKey)) {
      this.lastDecision = {
        kind: "no_provider_call",
        reason: discoveryComplete
          ? `Identifier ${query.normalizedText} is not marked unresolved in the current scoped inventory.`
          : "Run one focused semantic discovery first; symbol lookup is allowed only for identifiers that remain unresolved.",
      };
      this.diagnostics.push({
        code: "symbol_lookup_not_required",
        level: "info",
        message: this.lastDecision.reason,
        queryDigest: query.digest,
        providerCallRequired: false,
      });
      this.recordDecision(query, this.lastDecision);
      this.persistCheckpoint();
      return [];
    }
    if (!status.capabilities.includes("symbol.search")) {
      this.lastDecision = { kind: "unsupported", reason: `Code provider ${selected.name} does not support symbol.search.` };
      this.recordDecision(query, this.lastDecision);
      this.persistCheckpoint();
      throw new Error(this.lastDecision.reason);
    }
    this.prepareProviderCall(query);
    let results: CodeSearchHit[];
    try {
      results = await selected.symbols({
        workspace: options.workspace,
        text: options.text,
        ...(options.repositoryIds === undefined ? {} : { repositoryIds: options.repositoryIds }),
        limit,
      });
    } catch (error) {
      this.recordProviderError(query, error);
      throw error;
    }
    const degraded = results.some((hit) => hit.provenance.degraded === true);
    const bounded = this.ingestHits(query, options.workspace, results.slice(0, limit), results.length > limit);
    this.updateSymbolResolution(query, bounded.hits, [query.normalizedText]);
    this.cacheHitQuery(query, bounded.hits, !bounded.truncated, bounded.truncated, degraded, cacheFreshness(status));
    const output = this.returnHits(bounded.hits, query, this.lastDecision!);
    this.recordCompletion("code.symbols_completed", selected, options.workspace, query, output.length, bounded.truncated, degraded);
    return output;
  }

  async relationships(query: CodeRelationshipQuery, provider?: string): Promise<CodeRelationship[]> {
    await this.waitForActiveIndex();
    const selected = this.registry.get(provider);
    const status = await selected.status(query.workspace);
    const limit = boundedLimit(query.limit, this.limits.maxResults);
    const canonical = this.canonicalQuery({
      operation: "relationships",
      text: `${query.reference.provider}:${query.reference.repositoryId}:${query.reference.path}`,
      selected,
      status,
      workspace: query.workspace,
      repositoryIds: [query.reference.repositoryId],
      filters: {
        repositoryIds: [query.reference.repositoryId],
        relationshipKinds: query.kinds,
        depth: query.depth,
        reference: query.reference,
      },
      requestedLimit: limit,
    });
    const cached = this.relationshipQueries.get(canonical.digest);
    if (cached !== undefined && statusAllowsReuse(status)) {
      const decision = decideCanonicalQueryReuse(cached, canonical);
      if (decision.kind === "exact_reuse") {
        this.telemetry.cacheHits += 1;
        this.lastDecision = decision;
        return this.returnRelationships(cached.relationships.slice(0, limit), canonical, decision);
      }
    }
    if (cached !== undefined && !statusAllowsReuse(status)) {
      this.invalidateCachedQuery(canonical, "provider status no longer permits current relationship evidence reuse");
    } else this.noteInvalidation(canonical);
    if (!status.capabilities.includes("graph.relationships")) {
      this.lastDecision = { kind: "unsupported", reason: `Code provider ${selected.name} does not support graph.relationships.` };
      this.recordDecision(canonical, this.lastDecision);
      this.persistCheckpoint();
      throw new Error(this.lastDecision.reason);
    }
    this.prepareProviderCall(canonical);
    let results: CodeRelationship[];
    try {
      results = await selected.relationships({ ...query, limit });
    } catch (error) {
      this.recordProviderError(canonical, error);
      throw error;
    }
    const degraded = status.degraded === true || results.some((item) => item.provenance.degraded === true);
    const bounded = this.ingestRelationships(canonical, results.slice(0, limit), results.length > limit);
    this.relationshipQueries.set(canonical.digest, {
      query: canonical,
      requestDigest: canonicalQueryRequestDigest(canonical),
      relationships: bounded.relationships,
      coveredLimit: canonical.requestedLimit,
      complete: !bounded.truncated,
      truncated: bounded.truncated,
      degraded,
      freshness: cacheFreshness(status),
    });
    const output = this.returnRelationships(bounded.relationships, canonical, this.lastDecision!);
    this.recordCompletion("code.relationships_completed", selected, query.workspace, canonical, output.length, bounded.truncated, degraded);
    return output;
  }

  close() { return this.registry.close(); }

  private canonicalQuery(input: {
    operation: CanonicalQueryInput["operation"];
    text: string;
    selected: CodeProvider;
    status: CodeProviderStatus;
    workspace: CodeWorkspace;
    repositoryIds?: string[];
    mode?: CodeSearchMode;
    focus?: CodeSearchFocus;
    filters: CanonicalQueryInput["filters"];
    requestedLimit: number;
  }): CanonicalRetrievalQuery {
    const repositories = selectedRepositories(input.workspace, input.repositoryIds);
    const query = canonicalizeRetrievalQuery({
      operation: input.operation,
      text: input.text,
      provider: input.status.identity,
      workspaceId: input.workspace.id,
      repositories: repositories.map((repository) => ({ repositoryId: repository.id, snapshot: repository.snapshot })),
      ...(input.status.indexRevision === undefined ? {} : { indexRevision: input.status.indexRevision }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.focus === undefined ? {} : { focus: input.focus }),
      ...(input.filters === undefined ? {} : { filters: input.filters }),
      requestedLimit: input.requestedLimit,
    });
    this.invalidateOverlappingBindings(query);
    return query;
  }

  private invalidateOverlappingBindings(query: CanonicalRetrievalQuery): void {
    const requestDigest = canonicalQueryRequestDigest(query);
    const stale = new Map<string, { query: CanonicalRetrievalQuery; digests: string[]; reason: string }>();
    for (const cached of [...this.hitQueries.values(), ...this.relationshipQueries.values()]) {
      if (cached.requestDigest === requestDigest || cached.query.binding.workspaceId !== query.binding.workspaceId) continue;
      const reason = overlappingBindingDifference(cached.query, query);
      if (reason === undefined) continue;
      const key = JSON.stringify(cached.query.binding);
      const existing = stale.get(key);
      if (existing === undefined) stale.set(key, { query: cached.query, digests: [cached.query.digest], reason });
      else if (!existing.digests.includes(cached.query.digest)) existing.digests.push(cached.query.digest);
    }
    for (const item of stale.values()) {
      this.evictBinding(item.query);
      this.telemetry.invalidations += 1;
      this.invalidations.push(createInvalidation(item.reason, item.digests));
      this.lastDecision = { kind: "invalidated", reason: item.reason };
      this.pendingBindingInvalidationDigest = query.digest;
      this.diagnostics.push({
        code: "retrieval_invalidated",
        level: "info",
        message: item.reason,
        queryDigest: query.digest,
        providerCallRequired: false,
      });
    }
  }

  private rebindQuery(
    query: CanonicalRetrievalQuery,
    selected: CodeProvider,
    status: CodeProviderStatus,
    workspace: CodeWorkspace,
  ): CanonicalRetrievalQuery {
    return this.canonicalQuery({
      operation: query.operation,
      text: query.normalizedText,
      selected,
      status,
      workspace,
      ...(query.filters.repositoryIds.length === 0 ? {} : { repositoryIds: query.filters.repositoryIds }),
      ...(query.mode === undefined ? {} : { mode: query.mode }),
      ...(query.focus === undefined || query.focus === "mixed" ? {} : { focus: query.focus }),
      filters: query.filters,
      requestedLimit: query.requestedLimit,
    });
  }

  private reuseHits(query: CanonicalRetrievalQuery, status: CodeProviderStatus): CodeSearchHit[] | undefined {
    const cached = this.hitQueries.get(query.digest);
    if (cached !== undefined && statusAllowsReuse(status)) {
      const decision = decideCanonicalQueryReuse(cached, query);
      if (decision.kind === "exact_reuse") {
        this.telemetry.cacheHits += 1;
        this.lastDecision = decision;
        return cached.hits.slice(0, query.requestedLimit);
      }
    }
    if (cached !== undefined && !statusAllowsReuse(status)) {
      this.invalidateCachedQuery(query, "provider status no longer permits current evidence reuse");
    } else if (this.pendingBindingInvalidationDigest === query.digest) {
      this.pendingBindingInvalidationDigest = undefined;
    } else this.noteInvalidation(query);
    return undefined;
  }

  private evictBinding(query: CanonicalRetrievalQuery): void {
    this.clearUnresolvedForBinding(query);
    for (const [digest, cached] of this.hitQueries) if (sameBinding(cached.query, query)) this.hitQueries.delete(digest);
    for (const [digest, cached] of this.relationshipQueries) if (sameBinding(cached.query, query)) this.relationshipQueries.delete(digest);
  }

  private invalidateCachedQuery(query: CanonicalRetrievalQuery, reason: string): void {
    this.evictBinding(query);
    this.lastDecision = { kind: "invalidated", reason };
    this.telemetry.invalidations += 1;
    this.invalidations.push(createInvalidation(reason, [query.digest]));
    this.diagnostics.push({
      code: "retrieval_invalidated",
      level: "info",
      message: reason,
      queryDigest: query.digest,
      providerCallRequired: true,
    });
  }

  private noteInvalidation(query: CanonicalRetrievalQuery): void {
    const requestDigest = canonicalQueryRequestDigest(query);
    const previous = [
      ...this.hitQueries.values(),
      ...this.relationshipQueries.values(),
    ].filter((entry) => entry.requestDigest === requestDigest && entry.query.digest !== query.digest).at(-1);
    if (previous === undefined) {
      this.lastDecision = { kind: "provider_call", reason: "no complete current canonical result covers this request" };
      return;
    }
    const reason = bindingDifference(previous.query, query);
    this.evictBinding(previous.query);
    this.lastDecision = { kind: "invalidated", reason };
    this.telemetry.invalidations += 1;
    this.invalidations.push(createInvalidation(reason, [previous.query.digest]));
    this.diagnostics.push({
      code: "retrieval_invalidated",
      level: "info",
      message: reason,
      queryDigest: query.digest,
      providerCallRequired: true,
    });
  }

  private directReadHits(query: CanonicalRetrievalQuery): CodeSearchHit[] {
    const paths = pathCandidates(query.normalizedText);
    if (paths.length === 0) return [];
    return this.currentInventoryHits(query, (hit) => paths.includes(normalizePath(hit.path)));
  }

  private overlapHits(query: CanonicalRetrievalQuery): CodeSearchHit[] {
    if (query.operation !== "search" || !isIdentifier(query.normalizedText)) return [];
    return this.currentInventoryHits(
      query,
      (hit) => hit.symbol === query.normalizedText,
      (source) => source.complete
        && !source.truncated
        && !source.degraded
        && source.freshness === "current",
    );
  }

  private currentInventoryHits(
    query: CanonicalRetrievalQuery,
    predicate: (hit: CodeSearchHit) => boolean,
    sourcePredicate: (source: CachedHitQuery) => boolean = () => true,
  ): CodeSearchHit[] {
    const repositories = new Set(query.binding.repositories.map((repository) => repository.repositoryId));
    return [...this.inventoryHits.values()]
      .filter((entry) => predicate(entry.hit) && repositories.has(entry.hit.repositoryId))
      .filter((entry) => [...entry.sourceDigests].some((digest) => {
        const source = this.hitQueries.get(digest);
        return source !== undefined && sourcePredicate(source) && sameBinding(source.query, query);
      }))
      .map((entry) => entry.hit)
      .slice(0, query.requestedLimit);
  }

  private prepareProviderCall(query: CanonicalRetrievalQuery): void {
    this.requireProviderBudget(query);
    this.telemetry.providerCalls += 1;
    this.lastDecision = this.lastDecision?.kind === "invalidated"
      ? this.lastDecision
      : { kind: "provider_call", reason: "current inventory does not completely cover this request" };
    this.diagnostics.push({
      code: this.lastDecision.kind === "invalidated" ? "provider_call_after_invalidation" : "provider_call",
      level: "info",
      message: this.lastDecision.reason,
      queryDigest: query.digest,
      providerCallRequired: true,
    });
  }

  private requireProviderBudget(query?: CanonicalRetrievalQuery): void {
    if (this.providerRequests >= this.limits.maxProviderRequests) {
      const reason = `Code provider request budget exhausted (${this.providerRequests}/${this.limits.maxProviderRequests}). Inspect the session inventory or start a new retrieval session. Raw scanning is not an automatic fallback.`;
      this.lastDecision = { kind: "budget_denied", reason };
      this.diagnostics.push({ code: "provider_request_budget_exhausted", level: "error", message: reason, providerCallRequired: false });
      if (query !== undefined) this.recordDecision(query, this.lastDecision);
      this.persistCheckpoint();
      throw new Error(reason);
    }
    this.providerRequests += 1;
  }

  private ingestHits(query: CanonicalRetrievalQuery, workspace: CodeWorkspace, hits: CodeSearchHit[], initiallyTruncated: boolean): BoundedHits {
    const output = new Map<string, CodeSearchHit>();
    let truncated = initiallyTruncated;
    if (initiallyTruncated) this.noteTruncation("result_limit_truncated", "Provider results exceeded the bounded request limit.", query.digest);
    const scopedRepositories = new Set(query.binding.repositories.map((repository) => repository.repositoryId));

    for (const hit of hits) {
      if (!scopedRepositories.has(hit.repositoryId)) {
        truncated = true;
        this.diagnostics.push({ code: "provider_scope_leak_removed", level: "warning", message: `Removed out-of-scope result ${hit.repositoryId}:${hit.path}.`, queryDigest: query.digest });
        continue;
      }
      const pathKey = inventoryPathKey(query.binding.workspaceId, hit.repositoryId, hit.path);
      const reference = referenceKey(hit.reference);
      const chunk = chunkKey(hit);
      const symbol = symbolKey(hit);
      const entry = `${query.binding.workspaceId}:${chunk}`;
      const newPath = !this.pathKeys.has(pathKey);
      const newEntry = !this.evidenceEntryKeys.has(entry);

      if (newPath && this.pathKeys.size >= this.limits.maxUniquePaths) {
        truncated = true;
        this.noteTruncation("unique_path_budget_truncated", `Unique-path budget ${this.limits.maxUniquePaths} excluded ${hit.repositoryId}:${hit.path}.`, query.digest);
        continue;
      }
      if (newEntry && this.evidenceEntryKeys.size >= this.limits.maxEvidenceEntries) {
        truncated = true;
        this.noteTruncation("evidence_entry_budget_truncated", `Evidence-entry budget ${this.limits.maxEvidenceEntries} excluded ${hit.repositoryId}:${hit.path}.`, query.digest);
        continue;
      }

      if (this.pathKeys.has(pathKey)) this.telemetry.duplicatePathsRemoved += 1;
      if (this.referenceKeys.has(reference)) this.telemetry.duplicateReferencesRemoved += 1;
      if (this.chunkKeys.has(chunk)) this.telemetry.duplicateChunksRemoved += 1;
      if (symbol !== undefined && this.symbolKeys.has(symbol)) this.telemetry.duplicateSymbolsRemoved += 1;

      this.pathKeys.add(pathKey);
      this.referenceKeys.add(reference);
      this.referenceContexts.set(reference, { query, workspace });
      this.chunkKeys.add(chunk);
      if (symbol !== undefined) this.symbolKeys.add(symbol);
      if (newEntry) this.evidenceEntryKeys.add(entry);

      const previous = this.inventoryHits.get(pathKey);
      if (previous !== undefined) this.telemetry.duplicateResultsRemoved += 1;
      const bounded = previous === undefined ? this.boundHitPreview(hit) : { hit, truncated: false };
      truncated ||= bounded.truncated;
      if (bounded.truncated) this.noteTruncation("evidence_byte_budget_truncated", `Preview bytes were truncated for ${hit.repositoryId}:${hit.path}.`, query.digest);
      const merged = previous === undefined
        ? bounded.hit
        : previous.sourceDigests.has(query.digest)
          ? mergeHits(previous.hit, bounded.hit, query.digest)
          : mergeHits(bounded.hit, previous.hit, query.digest);
      const sources = previous?.sourceDigests ?? new Set<string>();
      sources.add(query.digest);
      this.inventoryHits.set(pathKey, { hit: merged, sourceDigests: sources });
      output.set(pathKey, merged);
    }

    this.telemetry.uniquePaths = this.pathKeys.size;
    this.telemetry.truncated ||= truncated;
    return {
      hits: [...output.values()].slice(0, query.requestedLimit).map((hit, index) => ({ ...hit, rank: index + 1 })),
      truncated,
    };
  }

  private boundHitPreview(hit: CodeSearchHit): { hit: CodeSearchHit; truncated: boolean } {
    if (hit.preview === undefined) return { hit: { ...hit }, truncated: false };
    const remaining = Math.max(0, this.limits.maxTotalBytes - this.retrievedBytes);
    const bounded = truncateUtf8(hit.preview, Math.min(this.limits.maxPreviewBytes, remaining));
    this.retrievedBytes += Buffer.byteLength(bounded.value);
    return {
      hit: { ...hit, preview: bounded.value },
      truncated: bounded.truncated,
    };
  }

  private cacheHitQuery(
    query: CanonicalRetrievalQuery,
    hits: CodeSearchHit[],
    complete: boolean,
    truncated: boolean,
    degraded: boolean,
    freshness: CachedHitQuery["freshness"],
  ): void {
    this.hitQueries.set(query.digest, {
      query,
      requestDigest: canonicalQueryRequestDigest(query),
      hits,
      coveredLimit: query.requestedLimit,
      complete,
      truncated,
      degraded,
      freshness,
    });
  }

  private ingestRelationships(query: CanonicalRetrievalQuery, relationships: CodeRelationship[], initiallyTruncated: boolean): BoundedRelationships {
    const output: CodeRelationship[] = [];
    const seen = new Set<string>();
    let truncated = initiallyTruncated;
    if (initiallyTruncated) this.noteTruncation("result_limit_truncated", "Provider relationships exceeded the bounded request limit.", query.digest);
    for (const relationship of relationships) {
      const key = `${relationship.kind}:${referenceKey(relationship.source)}:${referenceKey(relationship.target)}`;
      if (seen.has(key)) {
        this.telemetry.duplicateResultsRemoved += 1;
        this.telemetry.duplicateReferencesRemoved += 1;
        continue;
      }
      const existingEntry = this.evidenceEntryKeys.has(`relationship:${key}`);
      if (existingEntry) {
        this.telemetry.duplicateResultsRemoved += 1;
        this.telemetry.duplicateReferencesRemoved += 1;
        continue;
      }
      if (this.evidenceEntryKeys.size >= this.limits.maxEvidenceEntries) {
        truncated = true;
        this.noteTruncation("evidence_entry_budget_truncated", `Evidence-entry budget ${this.limits.maxEvidenceEntries} excluded a relationship.`, query.digest);
        break;
      }
      const pathKey = inventoryPathKey(query.binding.workspaceId, relationship.target.repositoryId, relationship.target.path);
      if (!this.pathKeys.has(pathKey) && this.pathKeys.size >= this.limits.maxUniquePaths) {
        truncated = true;
        this.noteTruncation("unique_path_budget_truncated", `Unique-path budget ${this.limits.maxUniquePaths} excluded ${relationship.target.repositoryId}:${relationship.target.path}.`, query.digest);
        continue;
      }
      seen.add(key);
      this.evidenceEntryKeys.add(`relationship:${key}`);
      this.pathKeys.add(pathKey);
      output.push(relationship);
    }
    this.telemetry.uniquePaths = this.pathKeys.size;
    this.telemetry.truncated ||= truncated;
    return { relationships: output, truncated };
  }

  private noteTruncation(code: string, message: string, queryDigest?: string): void {
    this.telemetry.truncated = true;
    this.diagnostics.push({
      code,
      level: "warning",
      message,
      ...(queryDigest === undefined ? {} : { queryDigest }),
      providerCallRequired: false,
    });
  }

  private returnHits(hits: CodeSearchHit[], query: CanonicalRetrievalQuery, decision: RetrievalReuseDecision): CodeSearchHit[] {
    const observed = hits.map((hit, index) => observeHit({ ...hit, rank: index + 1 }, query.digest, decision));
    const bytes = observed.reduce((total, hit) => total + Buffer.byteLength(hit.preview ?? ""), 0);
    this.telemetry.bytesReturned += bytes;
    this.recordReuse(query, decision, observed.length);
    return observed;
  }

  private returnRelationships(relationships: CodeRelationship[], query: CanonicalRetrievalQuery, decision: RetrievalReuseDecision): CodeRelationship[] {
    const observed = relationships.map((relationship) => observeRelationship(relationship, query.digest, decision));
    this.recordReuse(query, decision, observed.length);
    return observed;
  }

  private recordReuse(query: CanonicalRetrievalQuery, decision: RetrievalReuseDecision, resultCount: number): void {
    if (decision.kind !== "exact_reuse" && decision.kind !== "overlap_reuse" && decision.kind !== "direct_read") return;
    this.recordDecision(query, decision);
    this.persistCheckpoint();
    this.ledger.append({
      kind: "code.retrieval_reused",
      actor: "system",
      payload: {
        sessionId: this.sessionId,
        queryDigest: query.digest,
        operation: query.operation,
        decision,
        resultCount,
        budget: this.budgetSnapshot(),
        telemetry: this.telemetry,
      },
    });
  }

  private recordProviderError(query: CanonicalRetrievalQuery, error: unknown): void {
    const message = errorMessage(error);
    this.diagnostics.push({ code: "provider_error", level: "error", message, queryDigest: query.digest, providerCallRequired: true });
    this.recordDecision(query, this.lastDecision ?? { kind: "provider_call", reason: "provider call failed before producing evidence" });
    this.persistCheckpoint();
    this.ledger.append({ kind: "code.retrieval_failed", actor: "system", payload: { sessionId: this.sessionId, queryDigest: query.digest, operation: query.operation, error: message, budget: this.budgetSnapshot() } });
  }

  private recordCompletion(
    kind: string,
    selected: CodeProvider,
    workspace: CodeWorkspace,
    query: CanonicalRetrievalQuery,
    resultCount: number,
    truncated: boolean,
    degraded: boolean,
  ): void {
    this.recordDecision(query, this.lastDecision ?? { kind: "provider_call", reason: "provider returned bounded evidence" });
    try {
      this.persistCheckpoint();
    } catch (error) {
      this.hitQueries.delete(query.digest);
      this.relationshipQueries.delete(query.digest);
      throw error;
    }
    this.ledger.append({
      kind,
      actor: "system",
      payload: {
        sessionId: this.sessionId,
        provider: selected.name,
        workspaceId: workspace.id,
        queryDigest: query.digest,
        operation: query.operation,
        resultCount,
        decision: this.lastDecision,
        truncated,
        degraded,
        budget: this.budgetSnapshot(),
        telemetry: this.telemetry,
      },
    });
  }

  private budgetSnapshot(): RetrievalBudgetSnapshot {
    return {
      providerRequestsUsed: this.providerRequests,
      providerRequestsLimit: this.limits.maxProviderRequests,
      uniquePathsUsed: this.pathKeys.size,
      uniquePathsLimit: this.limits.maxUniquePaths,
      evidenceEntriesUsed: this.evidenceEntryKeys.size,
      evidenceEntriesLimit: this.limits.maxEvidenceEntries,
      fetchesUsed: this.fetched,
      fetchesLimit: this.limits.maxFetches,
      bytesUsed: this.retrievedBytes,
      bytesLimit: this.limits.maxTotalBytes,
    };
  }

  private clearUnresolvedForBinding(query: CanonicalRetrievalQuery): void {
    const prefix = `${retrievalBindingKey(query)}\0`;
    for (const key of this.unresolvedSymbolKeys) if (key.startsWith(prefix)) this.unresolvedSymbolKeys.delete(key);
  }

  private semanticDiscoveryComplete(query: CanonicalRetrievalQuery): boolean {
    return [...this.hitQueries.values()].some((cached) =>
      cached.query.operation === "search"
      && sameBinding(cached.query, query)
      && cached.complete
      && !cached.truncated
      && !cached.degraded
      && cached.freshness === "current");
  }

  private updateSymbolResolution(
    query: CanonicalRetrievalQuery,
    hits: CodeSearchHit[],
    explicitIdentifiers: string[] | undefined,
  ): void {
    const resolved = new Set(hits.flatMap((hit) => hit.symbol === undefined ? [] : [hit.symbol]));
    const candidates = identifierCandidates(query.normalizedText, explicitIdentifiers);
    for (const symbol of resolved) this.unresolvedSymbolKeys.delete(scopedSymbolKey(query, symbol));
    for (const candidate of candidates) {
      const key = scopedSymbolKey(query, candidate);
      if (resolved.has(candidate)) this.unresolvedSymbolKeys.delete(key);
      else this.unresolvedSymbolKeys.add(key);
    }
  }

  private compactEvidence(): PersistedRetrievalEvidence[] {
    const evidence = new Map<string, PersistedRetrievalEvidence>();
    for (const [pathKey, entry] of this.inventoryHits) {
      const activeDigests = [...entry.sourceDigests].filter((digest) => this.hitQueries.has(digest)).sort();
      if (activeDigests.length === 0) continue;
      const activeQueries = activeDigests.map((digest) => this.hitQueries.get(digest)!);
      const freshness = activeQueries.every((query) => query.freshness === "current" && !query.degraded)
        ? "current" as const
        : "unknown" as const;
      const { provenance, provenanceObservations, ...unboundedValue } = entry.hit;
      const value = compactHitValue(unboundedValue);
      evidence.set(`hit:${pathKey}`, {
        digest: `hit:${pathKey}`,
        kind: "hit",
        queryDigests: activeDigests,
        value,
        provenance: uniqueProvenance([
          { ...compactProvenance(provenance), freshness },
          ...(provenanceObservations ?? []).map((item) => ({ ...compactProvenance(item), freshness: "unknown" as const })),
        ]),
      });
    }
    for (const cached of this.relationshipQueries.values()) {
      for (const relationship of cached.relationships) {
        const digest = relationshipEvidenceDigest(relationship);
        const existing = evidence.get(digest);
        const { provenance, provenanceObservations, ...unboundedValue } = relationship;
        const value = compactRelationshipValue(unboundedValue);
        evidence.set(digest, {
          digest,
          kind: "relationship",
          queryDigests: [...new Set([...(existing?.queryDigests ?? []), cached.query.digest])].sort(),
          value,
          provenance: uniqueProvenance([
            { ...compactProvenance(provenance), freshness: cached.freshness },
            ...(provenanceObservations ?? []).map((item) => ({ ...compactProvenance(item), freshness: "unknown" as const })),
            ...(existing?.provenance ?? []).map((item) => ({ ...item, freshness: "unknown" as const })),
          ]),
        });
      }
    }
    return [...evidence.values()].sort((left, right) => left.digest.localeCompare(right.digest));
  }

  private persistCheckpoint(status: PersistedRetrievalCheckpoint["status"] = "active"): void {
    const evidence = this.compactEvidence();
    const evidenceForQuery = (queryDigest: string) => evidence
      .filter((item) => item.queryDigests.includes(queryDigest))
      .map((item) => item.digest);
    const requests = [
      ...[...this.hitQueries.values()].map((cached) => ({
        query: cached.query,
        requestDigest: cached.requestDigest,
        evidenceDigests: evidenceForQuery(cached.query.digest),
        coveredLimit: cached.coveredLimit,
        complete: cached.complete,
        truncated: cached.truncated,
        degraded: cached.degraded,
        freshness: cached.freshness,
        decision: this.decisionFor(cached.query.digest),
      })),
      ...[...this.relationshipQueries.values()].map((cached) => ({
        query: cached.query,
        requestDigest: cached.requestDigest,
        evidenceDigests: evidenceForQuery(cached.query.digest),
        coveredLimit: cached.coveredLimit,
        complete: cached.complete,
        truncated: cached.truncated,
        degraded: cached.degraded,
        freshness: cached.freshness,
        decision: this.decisionFor(cached.query.digest),
      })),
    ];
    this.ledger.saveRetrievalCheckpoint({
      sessionId: this.sessionId,
      status,
      startedAt: this.sessionStartedAt,
      updatedAt: nowIso(),
      budget: this.budgetSnapshot(),
      telemetry: { ...this.telemetry },
      ...(this.lastDecision === undefined ? {} : { lastDecision: this.lastDecision }),
      requests,
      evidence,
      invalidations: this.invalidations.slice(-this.limits.maxEvidenceEntries),
      diagnostics: this.diagnostics.slice(-this.limits.maxEvidenceEntries),
      decisions: this.decisions.slice(-this.limits.maxEvidenceEntries),
    }, this.persistenceLimits);
  }

  private hydrateCheckpoint(checkpoint: PersistedRetrievalCheckpoint | undefined): void {
    if (checkpoint === undefined || checkpoint.status !== "active") return;
    this.sessionStartedAt = checkpoint.startedAt;
    this.fetched = checkpoint.budget.fetchesUsed;
    this.retrievedBytes = checkpoint.budget.bytesUsed;
    this.providerRequests = checkpoint.budget.providerRequestsUsed;
    this.telemetry = { ...checkpoint.telemetry };
    this.lastDecision = checkpoint.lastDecision;
    this.diagnostics = checkpoint.diagnostics.slice(-this.limits.maxEvidenceEntries);
    this.decisions = checkpoint.decisions.slice(-this.limits.maxEvidenceEntries);
    this.invalidations = checkpoint.invalidations.slice(-this.limits.maxEvidenceEntries);

    const values = new Map(checkpoint.evidence.map((item) => [item.digest, item]));
    for (const item of checkpoint.evidence) {
      if (item.kind !== "hit" || item.provenance.length === 0) continue;
      const [provenance, ...provenanceObservations] = item.provenance;
      const hit = {
        ...(item.value as Omit<CodeSearchHit, "provenance" | "provenanceObservations">),
        provenance: provenance!,
        ...(provenanceObservations.length === 0 ? {} : { provenanceObservations }),
      };
      const workspaceId = provenance!.workspaceId;
      const key = inventoryPathKey(workspaceId, hit.repositoryId, hit.path);
      this.inventoryHits.set(key, { hit, sourceDigests: new Set(item.queryDigests) });
      this.pathKeys.add(key);
      this.evidenceEntryKeys.add(`${workspaceId}:${chunkKey(hit)}`);
      this.referenceKeys.add(referenceKey(hit.reference));
      this.chunkKeys.add(chunkKey(hit));
      const symbol = symbolKey(hit);
      if (symbol !== undefined) this.symbolKeys.add(symbol);
    }
    for (const request of checkpoint.requests) {
      const requestEvidence = request.evidenceDigests.flatMap((digest) => {
        const item = values.get(digest);
        return item === undefined ? [] : [item];
      });
      if (request.query.operation === "relationships") {
        const relationships = requestEvidence.flatMap((item) => {
          if (item.kind !== "relationship" || item.provenance.length === 0) return [];
          const [provenance, ...provenanceObservations] = item.provenance;
          return [{
            ...(item.value as Omit<CodeRelationship, "provenance" | "provenanceObservations">),
            provenance: provenance!,
            ...(provenanceObservations.length === 0 ? {} : { provenanceObservations }),
          }];
        });
        this.relationshipQueries.set(request.query.digest, { ...request, relationships });
      } else {
        const hits = requestEvidence.flatMap((item) => {
          if (item.kind !== "hit" || item.provenance.length === 0) return [];
          const [provenance, ...provenanceObservations] = item.provenance;
          return [{
            ...(item.value as Omit<CodeSearchHit, "provenance" | "provenanceObservations">),
            provenance: provenance!,
            ...(provenanceObservations.length === 0 ? {} : { provenanceObservations }),
          }];
        });
        this.hitQueries.set(request.query.digest, { ...request, hits });
      }
    }
    for (const cached of this.hitQueries.values()) {
      this.updateSymbolResolution(
        cached.query,
        cached.hits,
        cached.query.operation === "symbols"
          ? [cached.query.normalizedText]
          : cached.query.filters.literalHints,
      );
    }
    for (let index = this.pathKeys.size; index < checkpoint.budget.uniquePathsUsed; index += 1) {
      this.pathKeys.add(`persisted-path-budget:${index}`);
    }
    for (let index = this.evidenceEntryKeys.size; index < checkpoint.budget.evidenceEntriesUsed; index += 1) {
      this.evidenceEntryKeys.add(`persisted-entry-budget:${index}`);
    }
    this.telemetry.uniquePaths = this.pathKeys.size;
  }

  private decisionFor(queryDigest: string): RetrievalReuseDecision {
    return this.decisions.findLast((item) => item.queryDigest === queryDigest)?.decision
      ?? { kind: "provider_call", reason: "persisted query checkpoint" };
  }

  private recordDecision(query: CanonicalRetrievalQuery, decision: RetrievalReuseDecision): void {
    this.decisions.push({
      queryDigest: query.digest,
      operation: query.operation,
      workspaceId: query.binding.workspaceId,
      repositoryIds: query.binding.repositories.map((repository) => repository.repositoryId),
      decision,
      decidedAt: nowIso(),
    });
    if (this.decisions.length > this.limits.maxEvidenceEntries) this.decisions.splice(0, this.decisions.length - this.limits.maxEvidenceEntries);
  }

  private async waitForActiveIndex(): Promise<void> {
    if (this.activeIndex !== undefined) await this.activeIndex;
  }

  private setIndexStatus(status: CodeIndexCoordinatorStatus): void {
    this.indexStatus = status;
    for (const listener of this.indexListeners) listener(this.indexingStatus());
  }
}

function emptyTelemetry(): RetrievalTelemetry {
  return {
    providerCalls: 0,
    cacheHits: 0,
    overlapReuses: 0,
    uniquePaths: 0,
    duplicateResultsRemoved: 0,
    duplicatePathsRemoved: 0,
    duplicateSymbolsRemoved: 0,
    duplicateChunksRemoved: 0,
    duplicateReferencesRemoved: 0,
    bytesReturned: 0,
    truncated: false,
    invalidations: 0,
  };
}

function validateLimits(limits: CodeServiceLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
}

function validatePersistenceLimits(limits: RetrievalPersistenceLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
}
