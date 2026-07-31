import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { sourceRevisionIdentity, sourceSnapshotBase } from "../repository/snapshot.ts";
import { nowIso } from "../util/ids.ts";
import { createOpaqueIndexRevision } from "./canonical-query.ts";
import { McpStdioClient, type McpToolCallResult, type McpToolDefinition } from "./mcp-stdio-client.ts";
import { UnsupportedCodeCapabilityError, type CodeProvider } from "./provider.ts";
import { applyCodeSearchFocus, focusedProviderLimit, rankCodePathsByFocus, resolveCodeSearchFocus } from "./focus.ts";
import { ATELIER_VERSION } from "../version.ts";
import { minimalEnvironment } from "../process/environment.ts";
import { runProcess, type ProcessResult } from "../process/async-process.ts";
import type {
  CodeCapability,
  CodeChunk,
  CodeIndexState,
  CodeProviderIdentity,
  CodeProviderStatus,
  CodeProvenance,
  CodeReference,
  CodeRelationship,
  CodeRelationshipQuery,
  CodeSearchHit,
  CodeSearchMode,
  CodeSearchQuery,
  CodeSymbolQuery,
  CodeWorkspace,
} from "./types.ts";

export interface CodesearchProviderOptions {
  command?: string;
  cwd: string;
  mode?: "auto" | "local" | "client";
  timeoutMs?: number;
  indexTimeoutMs?: number;
  pollIntervalMs?: number;
  environment?: Record<string, string>;
}

interface CodesearchReferenceData {
  chunkId?: string;
  chunkRef?: string;
  project?: string;
  symbol?: string;
}

export class CodesearchProvider implements CodeProvider {
  readonly name = "codesearch";
  private readonly command: string;
  private readonly cwd: string;
  private readonly mode: "auto" | "local" | "client";
  private readonly timeoutMs: number;
  private readonly indexTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly environment: Record<string, string> | undefined;
  private readonly indexSelectionStatePath: string;
  private client: McpStdioClient | undefined;
  private identity: CodeProviderIdentity = { name: "codesearch", instanceId: "codesearch-local" };
  private tools: McpToolDefinition[] = [];
  private indexState: CodeIndexState = "unknown";
  private lastIndexedAt?: string;
  private lastQueryAt?: string;
  private detail?: string;
  private routingMode: "unknown" | "local" | "client" = "unknown";
  private workspace: CodeWorkspace | undefined;
  private readonly indexedSnapshots = new Map<string, string>();
  private lastWarnings: string[] = [];
  private localIndexWarnings: string[] = [];

  constructor(options: CodesearchProviderOptions) {
    this.command = options.command ?? "codesearch";
    this.cwd = resolve(options.cwd);
    this.mode = options.mode ?? "auto";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.indexTimeoutMs = options.indexTimeoutMs ?? 300_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.environment = options.environment;
    this.indexSelectionStatePath = resolve(this.cwd, ".atelier", "codesearch-index-state.json");
  }

  async status(workspace?: CodeWorkspace): Promise<CodeProviderStatus> {
    if (workspace !== undefined) this.workspace = workspace;
    const version = this.detectVersion();
    if (version === undefined) {
      return {
        identity: this.identity,
        available: false,
        healthy: false,
        capabilities: [],
        indexState: "unknown",
        detail: `Unable to execute ${this.command}. Install codesearch or configure codeCommand.`,
      };
    }

    try {
      await this.connect();
      if (this.hasTool("status")) this.indexState = await this.readIndexState(this.workspace);
      const indexRevision = this.currentIndexRevision();
      return {
        identity: this.identity,
        available: true,
        healthy: true,
        capabilities: this.capabilities(),
        indexState: this.indexState,
        ...(indexRevision === undefined ? {} : { indexRevision }),
        ...(this.detail === undefined ? {} : { detail: this.detail }),
        ...(this.lastIndexedAt === undefined ? {} : { lastIndexedAt: this.lastIndexedAt }),
        ...(this.lastQueryAt === undefined ? {} : { lastQueryAt: this.lastQueryAt }),
        ...(this.indexedSnapshots.size === 0 ? {} : { indexedRevisions: Object.fromEntries(this.indexedSnapshots) }),
        ...(this.combinedWarnings().length === 0 ? {} : { degraded: true, warnings: this.combinedWarnings() }),
      };
    } catch (error) {
      const indexRevision = this.currentIndexRevision();
      return {
        identity: this.identity,
        available: true,
        healthy: false,
        capabilities: this.capabilities(),
        indexState: this.indexState,
        ...(indexRevision === undefined ? {} : { indexRevision }),
        detail: errorMessage(error),
        ...(this.lastIndexedAt === undefined ? {} : { lastIndexedAt: this.lastIndexedAt }),
        ...(this.lastQueryAt === undefined ? {} : { lastQueryAt: this.lastQueryAt }),
        ...(this.combinedWarnings().length === 0 ? {} : { degraded: true, warnings: this.combinedWarnings() }),
      };
    }
  }

  async ensureIndex(workspace: CodeWorkspace): Promise<CodeIndexState> {
    this.workspace = workspace;
    const version = this.detectVersion();
    if (version === undefined) throw new Error(`codesearch executable not found: ${this.command}`);
    const databasesPresentBeforeStartup = new Set(
      workspace.repositories
        .map((repository) => resolve(repository.root))
        .filter((repositoryRoot) => existsSync(resolve(repositoryRoot, ".codesearch.db"))),
    );
    await this.connect();
    this.indexState = "building";
    this.localIndexWarnings = [];
    const routedThroughServe = this.routingMode === "client" || this.mode === "client";

    // A self-contained codesearch MCP process keeps Tantivy's FTS writer open.
    // Running the CLI indexer while that subprocess is alive fails with LockBusy,
    // so local repair must stop MCP completely before invoking `codesearch index`.
    if (!routedThroughServe) await this.close();

    const selectionState = readIndexSelectionState(this.indexSelectionStatePath);
    for (const repository of workspace.repositories) {
      if (routedThroughServe) {
        await this.runIndexCommand(["index", "add", repository.root], repository.root, "index add");
      } else {
        // `index add` returns early when a local database already exists. The bare
        // `index <path>` command is the repair/update path and rebuilds a missing
        // HNSW index even when the file set is otherwise unchanged.
        //
        // Changes to ignore files alter the indexed corpus, but codesearch's
        // incremental path cannot remove files that still exist and merely became
        // ignored. Atelier therefore fingerprints the repository selection inputs
        // and requests one full rebuild whenever that fingerprint changes.
        const repositoryRoot = resolve(repository.root);
        const fingerprint = indexSelectionFingerprint(repositoryRoot, version);
        const priorFingerprint = selectionState.repositories[repositoryRoot]?.fingerprint;
        const selectionChanged = priorFingerprint !== fingerprint;
        const existingHealth = databasesPresentBeforeStartup.has(repositoryRoot) && selectionChanged
          ? this.readLocalVectorHealth(repository.root)
          : undefined;
        const force = existingHealth !== undefined && existingHealth.state !== "missing";
        await this.runIndexCommand(
          ["index", repository.root, ...(force ? ["--force"] : [])],
          repository.root,
          force ? "index --force" : "index",
        );
        const health = this.readLocalVectorHealth(repository.root);
        if (health.state !== "ready") {
          this.indexState = health.state;
          this.localIndexWarnings = [health.detail];
          throw new Error(`codesearch local vector index is not ready for ${repository.root}: ${health.detail}`);
        }
        selectionState.repositories[repositoryRoot] = {
          fingerprint,
          providerVersion: version,
          updatedAt: nowIso(),
        };
        writeIndexSelectionState(this.indexSelectionStatePath, selectionState);
      }
    }

    this.lastIndexedAt = nowIso();
    for (const repository of workspace.repositories) this.indexedSnapshots.set(repository.id, snapshotIdentity(repository.snapshot));
    await this.reconnect();
    return this.waitForReady(workspace);
  }


  private async runIndexCommand(args: string[], repositoryRoot: string, operation: string): Promise<void> {
    let result: ProcessResult;
    try {
      result = await runProcess(this.command, args, {
        cwd: repositoryRoot,
        environment: minimalEnvironment({ overrides: this.environment }),
        timeoutMs: this.indexTimeoutMs,
        maxOutputBytes: 256 * 1024,
      });
    } catch (error) {
      this.indexState = "failed";
      throw new Error(`codesearch ${operation} failed for ${repositoryRoot}: ${errorMessage(error)}`, { cause: error });
    }
    if (result.exitCode !== 0 || result.timedOut || result.aborted) {
      this.indexState = "failed";
      throw new Error(formatIndexFailure(operation, repositoryRoot, result, this.indexTimeoutMs));
    }
  }

  private readLocalVectorHealth(repositoryRoot: string): { state: CodeIndexState; detail: string } {
    const result = spawnSync(this.command, ["stats", repositoryRoot], {
      cwd: repositoryRoot,
      env: minimalEnvironment({ overrides: this.environment }),
      encoding: "utf8",
      shell: false,
      timeout: this.timeoutMs,
    });
    if (result.error || result.status !== 0) {
      return {
        state: "failed",
        detail: `unable to read codesearch vector statistics: ${result.stderr || result.stdout || result.error?.message || "unknown error"}`,
      };
    }
    const output = stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    if (/No database found/i.test(output)) return { state: "missing", detail: "codesearch database is missing" };
    const chunks = Number(output.match(/Total chunks:\s*(\d+)/i)?.[1] ?? "0");
    const indexed = /Indexed:\s*[^\n]*\bYes\b/i.test(output);
    if (indexed && chunks > 0) return { state: "ready", detail: `vector index ready with ${chunks} chunks` };
    if (chunks > 0) return { state: "failed", detail: `vector store contains ${chunks} chunks but the HNSW index is not built` };
    return { state: "missing", detail: "vector store contains no indexed chunks" };
  }

  private combinedWarnings(): string[] {
    return [...new Set([...this.localIndexWarnings, ...this.lastWarnings])];
  }

  async search(query: CodeSearchQuery): Promise<CodeSearchHit[]> {
    this.workspace = query.workspace;
    await this.requireTool("search", "search.semantic");
    await this.waitForReady(query.workspace);
    const requestedActualMode = mapSearchMode(query.mode);
    const resolvedFocus = resolveCodeSearchFocus(query.focus, query.text);
    const providerLimit = focusedProviderLimit(query.limit, resolvedFocus, requestedActualMode);
    const providerQuery = { ...query, limit: providerLimit };
    const scope = this.scopeArguments(query.workspace, query.repositoryIds);
    const primaryArgs = searchArguments(providerQuery, requestedActualMode, scope);
    const primary = await this.call("search", primaryArgs);
    this.lastQueryAt = nowIso();

    const primaryError = toolResponseError(primary);
    let data = extractData(primary);
    let rows = extractRows(data);
    let actualMode = requestedActualMode;
    let warnings: string[] = [];
    let postProcessing: string[] = providerLimit > query.limit
      ? [`overfetched up to ${providerLimit} compact provider results for ${resolvedFocus} focus`]
      : [];

    if (primaryError !== undefined) {
      if (query.mode === "semantic") {
        this.lastWarnings = [primaryError];
        throw new Error(`codesearch semantic search failed: ${primaryError}`);
      }
      const fallback = await this.literalFallback(providerQuery, scope, primaryError);
      data = fallback.data;
      rows = fallback.rows;
      actualMode = "lexical";
      warnings = [primaryError, ...fallback.warnings];
      postProcessing = [...postProcessing, "semantic search failed; merged bounded literal fallback results"];
      if (rows.length === 0) {
        this.lastWarnings = warnings;
        throw new Error(`codesearch semantic search failed and literal fallback returned no results: ${primaryError}`);
      }
    } else if (shouldAugmentSearch(query.mode, resolvedFocus)) {
      const augmentation = await this.literalCandidateSearch(providerQuery, scope, 6, providerLimit, "augmentation");
      if (augmentation.rows.length > 0) {
        rows = fuseSearchRows(rows, augmentation.rows, providerLimit);
        actualMode = "hybrid";
        postProcessing = [...postProcessing, "fused semantic results with bounded literal identifier augmentation"];
      }
      if (augmentation.failedCandidates > 0) {
        postProcessing = [...postProcessing, `literal augmentation skipped ${augmentation.failedCandidates} failed candidate query(s)`];
      }
    }

    this.lastWarnings = warnings;
    const indexState = inferIndexState(data, this.indexState);
    this.indexState = indexState;
    const normalized = rows.slice(0, providerLimit).map((row, index) => normalizeHit({
      row,
      rank: index + 1,
      query,
      actualMode,
      workspace: query.workspace,
      identity: this.identity,
      indexState,
      enforcedFilters: enforcedSearchFilters(query, actualMode),
      indexedSnapshots: Object.fromEntries(this.indexedSnapshots),
      postProcessing,
      warnings,
    }));
    const focused = applyCodeSearchFocus(normalized, query.focus, query.text);
    const focusProcessing = focused.focus === "all"
      ? []
      : [`reranked by ${focused.focus} focus with path diversification`];
    return focused.hits.slice(0, query.limit).map((hit, index) => ({
      ...hit,
      rank: index + 1,
      provenance: {
        ...hit.provenance,
        requestedFilters: { ...hit.provenance.requestedFilters, focus: query.focus ?? "auto", resolvedFocus: focused.focus },
        enforcedFilters: [...new Set([...hit.provenance.enforcedFilters, ...(focused.focus === "all" ? [] : ["focus"])])],
        postProcessing: [...hit.provenance.postProcessing, ...focusProcessing],
        reranked: focused.reranked,
      },
    }));
  }

  private async literalFallback(
    query: CodeSearchQuery,
    scope: Record<string, unknown>,
    primaryError: string,
  ): Promise<{ data: unknown; rows: Array<Record<string, unknown>>; warnings: string[] }> {
    const result = await this.literalCandidateSearch(query, scope, 6, query.limit, "fallback");
    const warnings = [...result.warnings];
    if (result.rows.length === 0) warnings.push(`literal fallback returned no results after semantic failure: ${primaryError}`);
    return { data: result.data, rows: result.rows, warnings };
  }

  private async literalCandidateSearch(
    query: CodeSearchQuery,
    scope: Record<string, unknown>,
    maxCandidates: number,
    perCandidateLimit: number,
    purpose: "augmentation" | "fallback",
  ): Promise<{ data: unknown; rows: Array<Record<string, unknown>>; warnings: string[]; failedCandidates: number }> {
    const candidates = literalQueryCandidates(query.text, query.literalHints, maxCandidates, purpose);
    const merged = new Map<string, { row: Record<string, unknown>; score: number }>();
    const warnings: string[] = [];
    let failedCandidates = 0;
    let lastData: unknown = {};

    for (const candidate of candidates) {
      const response = await this.call("search", {
        query: candidate,
        mode: "literal",
        compact: true,
        limit: perCandidateLimit,
        ...scope,
        ...(query.languages?.length === 1 ? { language: query.languages[0] } : {}),
        ...(query.pathGlobs?.length === 1 ? { file_glob: query.pathGlobs[0] } : {}),
      });
      const error = toolResponseError(response);
      if (error !== undefined) {
        failedCandidates += 1;
        warnings.push(`literal query ${JSON.stringify(candidate)} failed: ${error}`);
        continue;
      }
      lastData = extractData(response);
      const candidateRows = rankProviderRowsByFocus(extractRows(lastData), query);
      for (const [index, row] of candidateRows.entries()) {
        const key = rowPathIdentity(row);
        const contribution = 1 / (60 + index + 1);
        const existing = merged.get(key);
        if (existing === undefined) merged.set(key, { row: { ...row }, score: contribution });
        else existing.score += contribution;
      }
      if (merged.size >= query.limit * 3) break;
    }

    const rows = [...merged.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, query.limit)
      .map(({ row, score }, index) => ({ ...row, rank: index + 1, provider_score: score }));
    return { data: lastData, rows, warnings, failedCandidates };
  }

  async read(reference: CodeReference): Promise<CodeChunk> {
    await this.requireTool("get_chunk", "result.fetch_on_demand");
    const decoded = decodeReference(reference.opaqueId);
    const result = await this.call("get_chunk", decoded.chunkRef === undefined
      ? {
          chunk_id: numericOrString(decoded.chunkId ?? reference.opaqueId),
          context_lines: 0,
          ...(this.routingMode !== "client" || decoded.project === undefined ? {} : { project: decoded.project }),
        }
      : { chunk_ref: decoded.chunkRef, context_lines: 0 });
    const data = extractData(result);
    const row = firstRecord(data);
    const content = stringField(row, ["content", "code", "text", "chunk", "source"]) ?? extractText(result);
    if (!content) throw new Error(`codesearch returned no content for ${reference.opaqueId}`);
    const provenance = provenanceFor({
      identity: this.identity,
      workspaceId: "unknown",
      repositoryId: reference.repositoryId,
      requestedMode: "auto",
      actualMode: "auto",
      query: "",
      indexState: inferIndexState(data, this.indexState),
      requestedFilters: {},
      enforcedFilters: [],
    });
    const language = stringField(row, ["language", "lang"]);
    const startLine = numberField(row, ["start_line", "startLine", "line_start"]);
    const endLine = numberField(row, ["end_line", "endLine", "line_end"]);
    const rawPath = stringField(row, ["path", "file", "file_path"]) ?? reference.path;
    const repository = this.workspace?.repositories.find((candidate) => candidate.id === reference.repositoryId);
    return {
      reference: repository === undefined ? reference : { ...reference, path: normalizeRepositoryPath(repository, rawPath) },
      repositoryId: reference.repositoryId,
      path: repository === undefined ? rawPath : normalizeRepositoryPath(repository, rawPath),
      ...(language === undefined ? {} : { language }),
      ...(startLine === undefined ? {} : { startLine }),
      ...(endLine === undefined ? {} : { endLine }),
      content,
      provenance,
    };
  }

  async symbols(query: CodeSymbolQuery): Promise<CodeSearchHit[]> {
    this.workspace = query.workspace;
    await this.requireTool("find", "symbol.search");
    await this.waitForReady(query.workspace);
    const scope = this.scopeArguments(query.workspace, query.repositoryIds);
    const result = await this.call("find", { symbol: query.text, kind: "definition", limit: query.limit, ...scope });
    this.lastQueryAt = nowIso();
    const data = extractData(result);
    const rows = extractRows(data);
    const searchQuery: CodeSearchQuery = {
      workspace: query.workspace,
      text: query.text,
      mode: "lexical",
      ...(query.repositoryIds === undefined ? {} : { repositoryIds: query.repositoryIds }),
      limit: query.limit,
      includeTests: true,
      includeGenerated: false,
    };
    return rows.slice(0, query.limit).map((row, index) => normalizeHit({
      row,
      rank: index + 1,
      query: searchQuery,
      actualMode: "lexical",
      workspace: query.workspace,
      identity: this.identity,
      indexState: inferIndexState(data, this.indexState),
      enforcedFilters: query.repositoryIds ? ["repositoryIds"] : [],
      indexedSnapshots: Object.fromEntries(this.indexedSnapshots),
    }));
  }

  async relationships(query: CodeRelationshipQuery): Promise<CodeRelationship[]> {
    this.workspace = query.workspace;
    const supported = query.kinds.filter((kind) => kind === "imports" || kind === "dependencies" || kind === "references" || kind === "calls");
    if (supported.length === 0) throw new UnsupportedCodeCapabilityError("graph.relationships", this.name);
    await this.requireTool("find", "graph.relationships");
    await this.waitForReady(query.workspace);
    const decoded = decodeReference(query.reference.opaqueId);
    const output: CodeRelationship[] = [];
    for (const kind of supported) {
      const findKind = kind === "imports" ? "imports" : kind === "dependencies" ? "dependents" : "usages";
      const searchTarget = kind === "references" || kind === "calls" ? decoded.symbol ?? query.reference.path : query.reference.path;
      const referenceScope = this.scopeArguments(query.workspace, [query.reference.repositoryId]);
      const useImpact = kind === "calls" && this.hasTool("find_impact");
      const result = useImpact
        ? await this.call("find_impact", { symbol_name: searchTarget, ...referenceScope })
        : await this.call("find", {
            symbol: searchTarget,
            kind: findKind,
            limit: query.limit - output.length,
            ...referenceScope,
            ...(this.routingMode !== "client" || decoded.project === undefined ? {} : { project: decoded.project }),
          });
      const data = extractData(result);
      const rows = extractRows(data).slice(0, query.limit - output.length);
      for (const row of rows) {
        const target = referenceFromRow(row, query.workspace, this.name);
        const label = stringField(row, ["kind", "label", "relationship"]);
        output.push({
          kind,
          source: query.reference,
          target,
          ...(label === undefined ? {} : { label }),
          provenance: provenanceFor({
            identity: this.identity,
            workspaceId: query.workspace.id,
            repositoryId: target.repositoryId,
            requestedMode: "auto",
            actualMode: "auto",
            query: searchTarget,
            indexState: inferIndexState(data, this.indexState),
            requestedFilters: { kinds: query.kinds, depth: query.depth },
            enforcedFilters: ["kind"],
          }),
        });
      }
      if (output.length >= query.limit) break;
    }
    return output;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }

  private async connect(): Promise<void> {
    if (this.client !== undefined && this.tools.length > 0) return;
    this.client = new McpStdioClient(this.command, mcpArgs(this.mode), {
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      ...(this.environment === undefined ? {} : { environment: this.environment }),
    });
    const initialized = await this.client.initialize({ clientName: "atelier", clientVersion: ATELIER_VERSION });
    this.identity = {
      name: "codesearch",
      ...(initialized.serverInfo.version === undefined ? {} : { version: initialized.serverInfo.version }),
      instanceId: `${initialized.serverInfo.name}:${this.mode}`,
    };
    this.tools = await this.client.listTools();
    if (initialized.instructions !== undefined) {
      this.detail = initialized.instructions;
      this.routingMode = inferRoutingMode(initialized.instructions, this.mode);
    } else {
      this.routingMode = this.mode === "client" ? "client" : this.mode === "local" ? "local" : "unknown";
    }
  }

  private async reconnect(): Promise<void> {
    await this.close();
    this.tools = [];
    await this.connect();
  }


  private async readIndexState(workspace?: CodeWorkspace): Promise<CodeIndexState> {
    const scope = workspace === undefined ? {} : this.scopeArguments(workspace);
    const result = await this.call("status", { kind: "index", ...scope });
    return inferIndexState(extractData(result), inferIndexState(this.detail, this.indexState));
  }

  private async waitForReady(workspace: CodeWorkspace): Promise<CodeIndexState> {
    if (!this.hasTool("status")) {
      this.indexState = "ready";
      return this.indexState;
    }

    const deadline = Date.now() + this.indexTimeoutMs;
    let state = await this.readIndexState(workspace);
    while (state === "building" || state === "unknown") {
      if (Date.now() >= deadline) {
        this.indexState = state;
        throw new Error(`codesearch index did not become ready within ${this.indexTimeoutMs} ms for workspace ${workspace.name} (state: ${state})`);
      }
      await delay(this.pollIntervalMs);
      state = await this.readIndexState(workspace);
    }

    this.indexState = state;
    if (state !== "ready") {
      throw new Error(`codesearch index is ${state} for workspace ${workspace.name}; run atlr code index before querying`);
    }
    return state;
  }

  private scopeArguments(workspace: CodeWorkspace, repositoryIds?: string[]): Record<string, unknown> {
    if (this.routingMode === "local" || this.mode === "local") return {};
    const selected = repositoryIds?.length
      ? workspace.repositories.filter((repository) => repositoryIds.includes(repository.id))
      : workspace.repositories;
    if (selected.length === 1) {
      const repository = selected[0]!;
      return { project: repository.codesearchProject ?? repository.name ?? basename(repository.root) };
    }
    if (selected.length > 1) return { group: "all" };
    return {};
  }

  private async call(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    await this.connect();
    if (!this.hasTool(name)) throw new Error(`codesearch MCP server does not advertise tool: ${name}`);
    return this.client!.callTool(name, args);
  }

  private async requireTool(name: string, capability: CodeCapability): Promise<void> {
    await this.connect();
    if (!this.hasTool(name)) throw new UnsupportedCodeCapabilityError(capability, this.name);
  }

  private hasTool(name: string): boolean {
    return this.tools.some((tool) => tool.name === name);
  }

  private currentIndexRevision(): string | undefined {
    if (this.lastIndexedAt === undefined || this.indexedSnapshots.size === 0) return undefined;
    return createOpaqueIndexRevision({
      provider: this.identity,
      indexedRevisions: Object.fromEntries(this.indexedSnapshots),
      indexedAt: this.lastIndexedAt,
    });
  }

  private capabilities(): CodeCapability[] {
    const capabilities: CodeCapability[] = ["index.repository", "index.incremental"];
    if (this.currentIndexRevision() !== undefined) capabilities.push("index.revision_aware");
    if (this.routingMode === "client" || (this.routingMode === "unknown" && this.mode !== "local")) capabilities.push("index.multi_repository");
    if (this.hasTool("search")) capabilities.push("search.lexical", "search.semantic", "search.hybrid", "result.rerank");
    if (this.hasTool("find")) capabilities.push("symbol.search", "symbol.definition", "symbol.references", "graph.relationships", "graph.imports", "graph.dependencies");
    if (this.hasTool("find_impact")) capabilities.push("graph.relationships", "graph.calls", "graph.impact");
    if (this.hasTool("explore")) capabilities.push("file.outline");
    if (this.hasTool("get_chunk")) capabilities.push("result.fetch_on_demand");
    return [...new Set(capabilities)];
  }

  private detectVersion(): string | undefined {
    const result = spawnSync(this.command, ["--version"], {
      cwd: this.cwd,
      env: minimalEnvironment({ overrides: this.environment }),
      encoding: "utf8",
      shell: false,
      timeout: 5_000,
    });
    if (result.error || result.status !== 0) return undefined;
    const version = `${result.stdout ?? ""} ${result.stderr ?? ""}`.trim().match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0];
    if (version) this.identity = { ...this.identity, version };
    return version ?? "unknown";
  }
}

function mcpArgs(mode: "auto" | "local" | "client"): string[] {
  return mode === "auto" ? ["mcp"] : ["mcp", "--mode", mode];
}

function mapSearchMode(mode: CodeSearchMode): CodeSearchMode {
  return mode === "lexical" ? "lexical" : "semantic";
}

function semanticSearchMode(mode: CodeSearchMode): "auto" | "semantic" | "hybrid" {
  return mode === "hybrid" ? "hybrid" : mode === "semantic" ? "semantic" : "auto";
}


function searchArguments(query: CodeSearchQuery, actualMode: CodeSearchMode, scope: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {
    query: query.text,
    mode: actualMode === "lexical" ? "literal" : "semantic",
    ...(actualMode === "lexical" ? {} : { semantic_mode: semanticSearchMode(query.mode) }),
    compact: true,
    limit: query.limit,
    ...scope,
  };
  if (query.languages?.length === 1 && actualMode === "lexical") args.language = query.languages[0];
  const onlyPathGlob = query.pathGlobs?.length === 1 ? query.pathGlobs[0] : undefined;
  if (onlyPathGlob !== undefined) {
    if (actualMode === "lexical") args.file_glob = onlyPathGlob;
    else args.filter_path = prefixFromGlob(onlyPathGlob);
  }
  return args;
}

function toolResponseError(result: McpToolCallResult): string | undefined {
  const text = extractText(result).trim();
  if (result.isError === true) return text || "provider returned isError";
  if (!text) return undefined;
  if (/^(?:error|failed)\b/i.test(text) || /error (?:searching|opening|reading|querying)|vector store.*(?:error|failed)|database.*(?:error|failed)/i.test(text)) return text;
  return undefined;
}

function literalQueryCandidates(
  query: string,
  hints: string[] | undefined,
  limit = 6,
  purpose: "augmentation" | "fallback" = "augmentation",
): string[] {
  const stop = new Set(["about", "after", "atelier", "before", "choose", "code", "configured", "does", "from", "have", "initialize", "initializes", "intelligence", "into", "through", "where", "which", "with", "implemented", "implementation", "provider", "service", "search", "state", "tests"]);
  const explicit = (hints ?? []).map((value) => value.trim()).filter(Boolean);
  const quoted = [...query.matchAll(/[`"']([^`"']+)[`"']/g)].map((match) => match[1]!.trim()).filter(Boolean);
  const words = query.match(/[A-Za-z_$][A-Za-z0-9_$.-]*/g) ?? [];
  const codeLike = words.filter((word) => /[A-Z].*[A-Z]|[a-z][A-Z]|[.$]/.test(word));
  const significant = purpose === "fallback"
    ? words.filter((word) => word.length >= 4 && !stop.has(word.toLowerCase()))
    : [];
  const ordered = [...new Set([...explicit, ...codeLike, ...quoted, ...significant])];
  const selected = ordered.slice(0, limit);
  return selected.length > 0 ? selected : purpose === "fallback" ? [query] : [];
}

function shouldAugmentSearch(mode: CodeSearchMode, focus: ReturnType<typeof resolveCodeSearchFocus>): boolean {
  return (mode === "auto" || mode === "hybrid") && (focus === "source" || focus === "tests");
}

function fuseSearchRows(
  semanticRows: Array<Record<string, unknown>>,
  lexicalRows: Array<Record<string, unknown>>,
  limit: number,
): Array<Record<string, unknown>> {
  const merged = new Map<string, {
    row: Record<string, unknown>;
    semanticRank?: number;
    lexicalRank?: number;
    score: number;
    methods: Set<CodeSearchMode>;
  }>();

  const add = (rows: Array<Record<string, unknown>>, method: "semantic" | "lexical", weight: number) => {
    for (const [index, row] of rows.entries()) {
      const rank = index + 1;
      const key = rowPathIdentity(row);
      const existing = merged.get(key);
      const contribution = weight / (60 + rank);
      if (existing === undefined) {
        merged.set(key, {
          row: { ...row },
          ...(method === "semantic" ? { semanticRank: rank } : { lexicalRank: rank }),
          score: contribution,
          methods: new Set<CodeSearchMode>([method]),
        });
      } else {
        if (method === "semantic") {
          existing.semanticRank = Math.min(existing.semanticRank ?? rank, rank);
          existing.row = { ...row };
        } else existing.lexicalRank = Math.min(existing.lexicalRank ?? rank, rank);
        existing.score += contribution;
        existing.methods.add(method);
      }
    }
  };

  add(semanticRows, "semantic", 1);
  add(lexicalRows, "lexical", 1.1);
  return [...merged.values()]
    .sort((left, right) => right.score - left.score
      || (left.semanticRank ?? Number.MAX_SAFE_INTEGER) - (right.semanticRank ?? Number.MAX_SAFE_INTEGER)
      || (left.lexicalRank ?? Number.MAX_SAFE_INTEGER) - (right.lexicalRank ?? Number.MAX_SAFE_INTEGER))
    .slice(0, limit)
    .map((entry, index) => ({
      ...entry.row,
      atelier_rank: index + 1,
      provider_rank: entry.semanticRank ?? entry.lexicalRank ?? index + 1,
      provider_score: entry.score,
      retrieval_methods: [...entry.methods],
    }));
}

function rankProviderRowsByFocus(rows: Array<Record<string, unknown>>, query: CodeSearchQuery): Array<Record<string, unknown>> {
  const paths = rows.map((row) => String(row.path ?? row.file ?? row.file_path ?? row.relative_path ?? ""));
  const rankedPaths = rankCodePathsByFocus(paths, query.focus, query.text).paths;
  const order = new Map(rankedPaths.map((path, index) => [path, index]));
  return [...rows].sort((left, right) => {
    const leftPath = String(left.path ?? left.file ?? left.file_path ?? left.relative_path ?? "");
    const rightPath = String(right.path ?? right.file ?? right.file_path ?? right.relative_path ?? "");
    return (order.get(leftPath) ?? Number.MAX_SAFE_INTEGER) - (order.get(rightPath) ?? Number.MAX_SAFE_INTEGER);
  });
}

function rowPathIdentity(row: Record<string, unknown>): string {
  return `${row.project ?? row.repository ?? row.repo ?? row.alias ?? ""}:${row.path ?? row.file ?? row.file_path ?? row.relative_path ?? rowIdentity(row)}`;
}

function rowIdentity(row: Record<string, unknown>): string {
  return String(row.chunk_ref ?? row.chunkRef ?? row.chunk_id ?? row.chunkId ?? row.id ?? `${row.path ?? row.file ?? "unknown"}:${row.start_line ?? row.startLine ?? row.line ?? ""}`);
}

function prefixFromGlob(glob: string): string {
  return glob.split(/[?*[]/, 1)[0]?.replace(/\/$/, "") ?? glob;
}

function enforcedSearchFilters(query: CodeSearchQuery, mode: CodeSearchMode): string[] {
  const filters: string[] = [];
  if (query.repositoryIds?.length) filters.push("repositoryIds");
  if (query.languages?.length === 1 && mode === "lexical") filters.push("languages");
  if (query.pathGlobs?.length === 1) filters.push("pathGlobs");
  return filters;
}

function extractData(result: McpToolCallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = extractText(result);
  if (!text) return {};
  try { return JSON.parse(text) as unknown; } catch { /* continue */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    try { return JSON.parse(fenced) as unknown; } catch { /* continue */ }
  }
  return { text };
}

function extractText(result: McpToolCallResult): string {
  return result.content?.filter((item) => item.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n") ?? "";
}

function extractRows(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data)) return [];
  for (const key of ["results", "hits", "chunks", "items", "matches", "definitions", "usages", "references"]) {
    const value = data[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return isRecord(data.result) ? extractRows(data.result) : [];
}

function firstRecord(data: unknown): Record<string, unknown> {
  if (isRecord(data)) {
    for (const key of ["chunk", "result", "data"]) if (isRecord(data[key])) return data[key] as Record<string, unknown>;
    return data;
  }
  return extractRows(data)[0] ?? {};
}

function normalizeHit(options: {
  row: Record<string, unknown>;
  rank: number;
  query: CodeSearchQuery;
  actualMode: CodeSearchMode;
  workspace: CodeWorkspace;
  identity: CodeProviderIdentity;
  indexState: CodeIndexState;
  enforcedFilters: string[];
  indexedSnapshots?: Record<string, string>;
  postProcessing?: string[];
  warnings?: string[];
}): CodeSearchHit {
  const { row, query, actualMode, workspace, identity, indexState } = options;
  const project = stringField(row, ["project", "repository", "repo", "alias"]);
  const rawPath = stringField(row, ["path", "file", "file_path", "relative_path"]) ?? "unknown";
  const repository = resolveRepository(workspace, project, rawPath);
  const path = normalizeRepositoryPath(repository, rawPath);
  const chunkId = String(row.chunk_id ?? row.chunkId ?? row.id ?? `${project ?? repository.id}:${path}:${options.rank}`);
  const chunkRef = stringField(row, ["chunk_ref", "chunkRef"]);
  const startLine = numberField(row, ["start_line", "startLine", "line_start", "line"]);
  const endLine = numberField(row, ["end_line", "endLine", "line_end"]) ?? startLine;
  const symbol = stringField(row, ["symbol", "name", "signature"]);
  const reference: CodeReference = {
    provider: "codesearch",
    opaqueId: encodeReference({
      ...(chunkRef === undefined ? { chunkId } : { chunkRef }),
      ...(project === undefined ? {} : { project }),
      ...(symbol === undefined ? {} : { symbol }),
    }),
    repositoryId: repository.id,
    path,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
  };
  const language = stringField(row, ["language", "lang"]);
  const providerScore = numberField(row, ["score", "rrf_score", "similarity", "provider_score"]);
  const summary = stringField(row, ["summary"]);
  const preview = stringField(row, ["preview", "snippet", "summary", "text", "signature", "content"]);
  const providerRank = numberField(row, ["provider_rank", "providerRank", "rank"]) ?? options.rank;
  const orchestrationRank = numberField(row, ["atelier_rank", "atelierRank"]) ?? providerRank;
  const retrievalMethods = codeSearchModes(row.retrieval_methods ?? row.retrievalMethods) ?? [actualMode];
  return {
    rank: orchestrationRank,
    providerRank,
    repositoryId: repository.id,
    repositoryName: repository.name,
    ...(sourceSnapshotBase(repository.snapshot) ? { revision: sourceSnapshotBase(repository.snapshot) } : {}),
    path,
    ...(reference.startLine === undefined ? {} : { startLine: reference.startLine }),
    ...(reference.endLine === undefined ? {} : { endLine: reference.endLine }),
    ...(symbol === undefined ? {} : { symbol }),
    ...(language === undefined ? {} : { language }),
    retrievalMethods,
    ...(providerScore === undefined ? {} : { providerScore }),
    ...(summary === undefined ? {} : { summary }),
    ...(preview === undefined ? {} : { preview: truncate(preview, 1_000) }),
    reference,
    provenance: provenanceFor({
      identity,
      workspaceId: workspace.id,
      repositoryId: repository.id,
      requestedMode: query.mode,
      actualMode,
      query: query.text,
      indexState,
      requestedFilters: {
        repositoryIds: query.repositoryIds,
        languages: query.languages,
        pathGlobs: query.pathGlobs,
        literalHints: query.literalHints,
        focus: query.focus ?? "auto",
        includeTests: query.includeTests,
        includeGenerated: query.includeGenerated,
      },
      enforcedFilters: options.enforcedFilters,
      ...(options.indexedSnapshots?.[repository.id] === undefined ? {} : { indexedSnapshot: options.indexedSnapshots[repository.id] }),
      currentSnapshot: snapshotIdentity(repository.snapshot),
      ...(options.postProcessing === undefined ? {} : { postProcessing: options.postProcessing }),
      ...(options.warnings === undefined ? {} : { warnings: options.warnings }),
    }),
  };
}

function codeSearchModes(value: unknown): CodeSearchMode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const modes = value.filter((item): item is CodeSearchMode => item === "auto" || item === "lexical" || item === "semantic" || item === "hybrid");
  return modes.length > 0 ? [...new Set(modes)] : undefined;
}

function referenceFromRow(row: Record<string, unknown>, workspace: CodeWorkspace, provider: string): CodeReference {
  const project = stringField(row, ["project", "repository", "repo", "alias"]);
  const rawPath = stringField(row, ["path", "file", "file_path", "relative_path"]) ?? "unknown";
  const repository = resolveRepository(workspace, project, rawPath);
  const path = normalizeRepositoryPath(repository, rawPath);
  const chunkId = String(row.chunk_id ?? row.chunkId ?? row.id ?? `${project ?? repository.id}:${path}`);
  const chunkRef = stringField(row, ["chunk_ref", "chunkRef"]);
  const startLine = numberField(row, ["start_line", "startLine", "line_start", "line"]);
  const endLine = numberField(row, ["end_line", "endLine", "line_end"]) ?? startLine;
  const symbol = stringField(row, ["symbol", "name", "signature"]);
  return {
    provider,
    opaqueId: encodeReference({
      ...(chunkRef === undefined ? { chunkId } : { chunkRef }),
      ...(project === undefined ? {} : { project }),
      ...(symbol === undefined ? {} : { symbol }),
    }),
    repositoryId: repository.id,
    path,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
  };
}

function resolveRepository(workspace: CodeWorkspace, project?: string, path?: string) {
  if (project) {
    const match = workspace.repositories.find((repo) => repo.id === project || repo.codesearchProject === project || repo.name === project || basename(repo.root) === project);
    if (match) return match;
  }
  if (path) {
    const absolute = workspace.repositories
      .filter((repository) => pathWithinRoot(repository.root, path))
      .sort((left, right) => right.root.length - left.root.length)[0];
    if (absolute) return absolute;
    const namespaced = workspace.repositories.find((repo) => repositoryAliases(repo).some((alias) => normalizeSlashes(path).startsWith(`${alias}/`)));
    if (namespaced) return namespaced;
  }
  return workspace.repositories[0] ?? { id: "unknown", name: project ?? "unknown", root: "", snapshot: { repositoryId: "unknown", workspaceId: workspace.id, vcs: "git" as const, headCommit: "unknown", dirtyGeneration: 0, dirtyFingerprint: "unknown", indexSchemaVersion: 1 } };
}

function normalizeRepositoryPath(repository: CodeWorkspace["repositories"][number], path: string): string {
  const normalized = normalizeSlashes(path).replace(/^\.\//, "");
  if (isAbsolute(path) && pathWithinRoot(repository.root, path)) {
    const candidate = normalizeSlashes(relative(repository.root, path));
    return candidate || ".";
  }
  for (const alias of repositoryAliases(repository)) {
    if (normalized.startsWith(`${alias}/`)) return normalized.slice(alias.length + 1);
  }
  return normalized;
}

function pathWithinRoot(root: string, path: string): boolean {
  if (!isAbsolute(path)) return false;
  const candidate = relative(resolve(root), resolve(path));
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

function repositoryAliases(repository: CodeWorkspace["repositories"][number]): string[] {
  return [...new Set([repository.codesearchProject, repository.name, basename(repository.root)].filter((value): value is string => Boolean(value)))];
}

function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function provenanceFor(options: {
  identity: CodeProviderIdentity;
  workspaceId: string;
  repositoryId: string;
  requestedMode: CodeSearchMode;
  actualMode: CodeSearchMode;
  query: string;
  indexState: CodeIndexState;
  requestedFilters: Record<string, unknown>;
  enforcedFilters: string[];
  indexedSnapshot?: string;
  currentSnapshot?: string;
  postProcessing?: string[];
  warnings?: string[];
}): CodeProvenance {
  return {
    provider: options.identity,
    workspaceId: options.workspaceId,
    repositoryId: options.repositoryId,
    requestedMode: options.requestedMode,
    actualMode: options.actualMode,
    query: options.query,
    retrievedAt: nowIso(),
    indexState: options.indexState,
    requestedFilters: options.requestedFilters,
    enforcedFilters: options.enforcedFilters,
    postProcessing: ["normalized by Atelier codesearch adapter", ...(options.postProcessing ?? [])],
    reranked: false,
    ...((options.warnings?.length ?? 0) === 0 ? {} : { degraded: true, warnings: options.warnings }),
    ...(options.indexedSnapshot === undefined ? { freshness: "unknown" as const } : {
      freshness: options.indexedSnapshot === options.currentSnapshot ? "current" as const : "known_stale" as const,
      indexedRevision: options.indexedSnapshot,
      ...(options.currentSnapshot === undefined ? {} : { currentRevision: options.currentSnapshot }),
    }),
  };
}

function inferIndexState(data: unknown, fallback: CodeIndexState = "unknown"): CodeIndexState {
  const indexState = findIndexStateValue(data);
  if (indexState !== undefined) return indexState;

  const text = collectStrings(data).join("\n").toLowerCase();
  if (/database:?\s+.*\(ready\)/.test(text) || /index(?:_state| state)?:?\s*ready/.test(text)) return "ready";
  if (/index(?:_state| state)?:?\s*(building|indexing)/.test(text)) return "building";
  if (/index(?:_state| state)?:?\s*stale/.test(text)) return "stale";
  if (/index(?:_state| state)?:?\s*(failed|error)/.test(text)) return "failed";
  if (/not indexed|index(?:_state| state)?:?\s*(missing|unindexed)/.test(text)) return "missing";
  return findStateValue(data) ?? fallback;
}

function findIndexStateValue(data: unknown): CodeIndexState | undefined {
  if (Array.isArray(data)) {
    for (const value of data) {
      const state = findIndexStateValue(value);
      if (state !== undefined) return state;
    }
    return undefined;
  }
  if (!isRecord(data)) return undefined;
  for (const key of ["index_state", "indexState"]) {
    const value = data[key];
    if (typeof value === "string") {
      const state = normalizeIndexState(value);
      if (state !== undefined) return state;
    }
  }
  if (typeof data.index_age_seconds === "number") return "ready";
  if (isRecord(data.index)) {
    const state = findStateValue(data.index);
    if (state !== undefined) return state;
  }
  for (const [key, value] of Object.entries(data)) {
    if (key === "index" || !isRecord(value) && !Array.isArray(value)) continue;
    const state = findIndexStateValue(value);
    if (state !== undefined) return state;
  }
  return undefined;
}

function findStateValue(data: unknown): CodeIndexState | undefined {
  if (Array.isArray(data)) {
    for (const value of data) {
      const state = findStateValue(value);
      if (state !== undefined) return state;
    }
    return undefined;
  }
  if (!isRecord(data)) return undefined;

  for (const key of ["index_state", "indexState", "state", "status"]) {
    const value = data[key];
    if (typeof value !== "string") continue;
    const state = normalizeIndexState(value);
    if (state !== undefined) return state;
  }
  if (typeof data.index_age_seconds === "number") return "ready";
  for (const value of Object.values(data)) {
    const state = findStateValue(value);
    if (state !== undefined) return state;
  }
  return undefined;
}

function normalizeIndexState(value: string): CodeIndexState | undefined {
  const raw = value.toLowerCase();
  if (raw.includes("build") || raw.includes("indexing")) return "building";
  if (raw.includes("stale")) return "stale";
  if (raw.includes("fail") || raw.includes("error")) return "failed";
  if (raw.includes("missing") || raw.includes("not found") || raw.includes("unindexed")) return "missing";
  if (raw.includes("ready") || raw.includes("current") || raw === "indexed" || raw === "ok") return "ready";
  return undefined;
}

function collectStrings(data: unknown): string[] {
  if (typeof data === "string") return [data];
  if (Array.isArray(data)) return data.flatMap(collectStrings);
  if (isRecord(data)) return Object.values(data).flatMap(collectStrings);
  return [];
}

function inferRoutingMode(instructions: string, configured: "auto" | "local" | "client"): "unknown" | "local" | "client" {
  const normalized = instructions.toLowerCase();
  if (normalized.includes("mode: self-contained") || normalized.includes("mode: local")) return "local";
  if (normalized.includes("mode: client") || normalized.includes("serve mode")) return "client";
  return configured === "client" ? "client" : configured === "local" ? "local" : "unknown";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function snapshotIdentity(snapshot: CodeWorkspace["repositories"][number]["snapshot"]): string {
  return sourceRevisionIdentity(snapshot);
}

function encodeReference(data: CodesearchReferenceData): string {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

function decodeReference(value: string): CodesearchReferenceData {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CodesearchReferenceData;
    if (!parsed || (typeof parsed.chunkId !== "string" && typeof parsed.chunkRef !== "string")) throw new Error("invalid reference");
    return parsed;
  } catch {
    return { chunkId: value };
  }
}

function numericOrString(value: string): number | string {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === "string" && record[key] !== "") return record[key] as string;
  return undefined;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface IndexSelectionState {
  version: 1;
  repositories: Record<string, { fingerprint: string; providerVersion: string; updatedAt: string }>;
}

const INDEX_SELECTION_FILES = [".gitignore", ".codesearchignore", ".osgrepignore"] as const;

function formatIndexFailure(
  operation: string,
  repositoryRoot: string,
  result: ProcessResult,
  timeoutMs: number,
): string {
  const details: string[] = [];
  if (result.timedOut) details.push(`timed out after ${timeoutMs} ms`);
  if (result.aborted) details.push("aborted");
  details.push(`exit status ${result.exitCode}`);
  if (result.signal !== undefined) details.push(`signal ${result.signal}`);
  if (result.stderrTruncated || result.stdoutTruncated) details.push("output truncated");

  const output = [result.stderr, result.stdout]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
  return `codesearch ${operation} failed for ${repositoryRoot}: ${details.join(", ")}${output ? `\n${output}` : ""}`;
}

function indexSelectionFingerprint(repositoryRoot: string, providerVersion: string): string {
  const hash = createHash("sha256");
  hash.update("atelier-codesearch-index-selection-v1\0");
  hash.update(providerVersion);
  hash.update("\0");
  for (const name of INDEX_SELECTION_FILES) {
    const path = resolve(repositoryRoot, name);
    hash.update(name);
    hash.update("\0");
    hash.update(existsSync(path) ? readFileSync(path) : Buffer.from("<missing>", "utf8"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readIndexSelectionState(path: string): IndexSelectionState {
  if (!existsSync(path)) return { version: 1, repositories: {} };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<IndexSelectionState>;
    if (value.version === 1 && value.repositories && typeof value.repositories === "object") {
      return { version: 1, repositories: value.repositories as IndexSelectionState["repositories"] };
    }
  } catch { /* invalid runtime state is replaced after the next successful index */ }
  return { version: 1, repositories: {} };
}

function writeIndexSelectionState(path: string, state: IndexSelectionState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
