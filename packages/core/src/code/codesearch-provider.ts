import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { nowIso } from "../util/ids.ts";
import { McpStdioClient, type McpToolCallResult, type McpToolDefinition } from "./mcp-stdio-client.ts";
import { UnsupportedCodeCapabilityError, type CodeProvider } from "./provider.ts";
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
  environment?: Record<string, string>;
}

interface CodesearchReferenceData {
  chunkId: string;
  project?: string;
}

export class CodesearchProvider implements CodeProvider {
  readonly name = "codesearch";
  private readonly command: string;
  private readonly cwd: string;
  private readonly mode: "auto" | "local" | "client";
  private readonly timeoutMs: number;
  private readonly environment: Record<string, string> | undefined;
  private client: McpStdioClient | undefined;
  private identity: CodeProviderIdentity = { name: "codesearch", instanceId: "codesearch-local" };
  private tools: McpToolDefinition[] = [];
  private indexState: CodeIndexState = "unknown";
  private lastIndexedAt?: string;
  private lastQueryAt?: string;
  private detail?: string;

  constructor(options: CodesearchProviderOptions) {
    this.command = options.command ?? "codesearch";
    this.cwd = resolve(options.cwd);
    this.mode = options.mode ?? "auto";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.environment = options.environment;
  }

  async status(): Promise<CodeProviderStatus> {
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
      const statusResult = this.hasTool("status")
        ? await this.call("status", { kind: "index" })
        : undefined;
      if (statusResult !== undefined) this.indexState = inferIndexState(extractData(statusResult));
      return {
        identity: this.identity,
        available: true,
        healthy: true,
        capabilities: this.capabilities(),
        indexState: this.indexState,
        ...(this.detail === undefined ? {} : { detail: this.detail }),
        ...(this.lastIndexedAt === undefined ? {} : { lastIndexedAt: this.lastIndexedAt }),
        ...(this.lastQueryAt === undefined ? {} : { lastQueryAt: this.lastQueryAt }),
      };
    } catch (error) {
      return {
        identity: this.identity,
        available: true,
        healthy: false,
        capabilities: this.capabilities(),
        indexState: this.indexState,
        detail: errorMessage(error),
        ...(this.lastIndexedAt === undefined ? {} : { lastIndexedAt: this.lastIndexedAt }),
        ...(this.lastQueryAt === undefined ? {} : { lastQueryAt: this.lastQueryAt }),
      };
    }
  }

  async ensureIndex(workspace: CodeWorkspace): Promise<CodeIndexState> {
    const version = this.detectVersion();
    if (version === undefined) throw new Error(`codesearch executable not found: ${this.command}`);
    this.indexState = "building";
    for (const repository of workspace.repositories) {
      const result = spawnSync(this.command, ["index", "add", repository.root], {
        cwd: this.cwd,
        env: { ...process.env, ...this.environment },
        encoding: "utf8",
        shell: false,
        timeout: this.timeoutMs,
      });
      if (result.error || result.status !== 0) {
        this.indexState = "failed";
        throw new Error(`codesearch index add failed for ${repository.root}: ${result.stderr || result.stdout || result.error?.message || "unknown error"}`);
      }
    }
    this.lastIndexedAt = nowIso();
    await this.reconnect();
    this.indexState = "ready";
    return this.indexState;
  }

  async search(query: CodeSearchQuery): Promise<CodeSearchHit[]> {
    await this.requireTool("search", "search.semantic");
    const actualMode = mapSearchMode(query.mode);
    const scope = scopeArguments(query.workspace, query.repositoryIds);
    const args: Record<string, unknown> = {
      query: query.text,
      mode: actualMode === "lexical" ? "literal" : "semantic",
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
    const result = await this.call("search", args);
    this.lastQueryAt = nowIso();
    const data = extractData(result);
    const rows = extractRows(data);
    const indexState = inferIndexState(data, this.indexState);
    this.indexState = indexState;
    return rows.slice(0, query.limit).map((row, index) => normalizeHit({
      row,
      rank: index + 1,
      query,
      actualMode,
      workspace: query.workspace,
      identity: this.identity,
      indexState,
      enforcedFilters: enforcedSearchFilters(query, actualMode),
    }));
  }

  async read(reference: CodeReference): Promise<CodeChunk> {
    await this.requireTool("get_chunk", "result.fetch_on_demand");
    const decoded = decodeReference(reference.opaqueId);
    const result = await this.call("get_chunk", {
      chunk_id: numericOrString(decoded.chunkId),
      context_lines: 0,
      ...(decoded.project === undefined ? {} : { project: decoded.project }),
    });
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
    return {
      reference,
      repositoryId: reference.repositoryId,
      path: stringField(row, ["path", "file", "file_path"]) ?? reference.path,
      ...(language === undefined ? {} : { language }),
      ...(startLine === undefined ? {} : { startLine }),
      ...(endLine === undefined ? {} : { endLine }),
      content,
      provenance,
    };
  }

  async symbols(query: CodeSymbolQuery): Promise<CodeSearchHit[]> {
    await this.requireTool("find", "symbol.search");
    const scope = scopeArguments(query.workspace, query.repositoryIds);
    const result = await this.call("find", { symbol: query.text, kind: "definition", ...scope });
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
    }));
  }

  async relationships(query: CodeRelationshipQuery): Promise<CodeRelationship[]> {
    const supported = query.kinds.filter((kind) => kind === "imports" || kind === "dependencies" || kind === "references");
    if (supported.length === 0) throw new UnsupportedCodeCapabilityError("graph.relationships", this.name);
    await this.requireTool("find", "graph.relationships");
    const decoded = decodeReference(query.reference.opaqueId);
    const symbol = query.reference.path;
    const output: CodeRelationship[] = [];
    for (const kind of supported) {
      const findKind = kind === "imports" ? "imports" : kind === "dependencies" ? "dependents" : "usages";
      const result = await this.call("find", {
        symbol,
        kind: findKind,
        ...(decoded.project === undefined ? {} : { project: decoded.project }),
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
            query: symbol,
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
    const initialized = await this.client.initialize({ clientName: "atelier", clientVersion: "0.6.0" });
    this.identity = {
      name: "codesearch",
      ...(initialized.serverInfo.version === undefined ? {} : { version: initialized.serverInfo.version }),
      instanceId: `${initialized.serverInfo.name}:${this.mode}`,
    };
    this.tools = await this.client.listTools();
    if (initialized.instructions !== undefined) this.detail = initialized.instructions;
  }

  private async reconnect(): Promise<void> {
    await this.close();
    this.tools = [];
    await this.connect();
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

  private capabilities(): CodeCapability[] {
    const capabilities: CodeCapability[] = ["index.repository", "index.incremental"];
    if (this.mode !== "local") capabilities.push("index.multi_repository");
    if (this.hasTool("search")) capabilities.push("search.lexical", "search.semantic", "search.hybrid");
    if (this.hasTool("find")) capabilities.push("symbol.search", "symbol.definition", "symbol.references", "graph.relationships", "graph.imports", "graph.dependencies");
    if (this.hasTool("get_chunk")) capabilities.push("result.fetch_on_demand");
    return [...new Set(capabilities)];
  }

  private detectVersion(): string | undefined {
    const result = spawnSync(this.command, ["--version"], {
      cwd: this.cwd,
      env: { ...process.env, ...this.environment },
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
  return mode === "lexical" ? "lexical" : mode === "auto" ? "hybrid" : mode;
}

function scopeArguments(workspace: CodeWorkspace, repositoryIds?: string[]): Record<string, unknown> {
  const selected = repositoryIds?.length ? workspace.repositories.filter((repo) => repositoryIds.includes(repo.id)) : workspace.repositories;
  if (selected.length === 1) return { project: basename(selected[0]!.root) };
  if (selected.length > 1) return { group: "all" };
  return {};
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
}): CodeSearchHit {
  const { row, query, actualMode, workspace, identity, indexState } = options;
  const project = stringField(row, ["project", "repository", "repo", "alias"]);
  const repository = resolveRepository(workspace, project, stringField(row, ["path", "file", "file_path"]));
  const path = stringField(row, ["path", "file", "file_path", "relative_path"]) ?? "unknown";
  const chunkId = String(row.chunk_id ?? row.chunkId ?? row.id ?? `${project ?? repository.id}:${path}:${options.rank}`);
  const startLine = numberField(row, ["start_line", "startLine", "line_start"]);
  const endLine = numberField(row, ["end_line", "endLine", "line_end"]);
  const reference: CodeReference = {
    provider: "codesearch",
    opaqueId: encodeReference({ chunkId, ...(project === undefined ? {} : { project }) }),
    repositoryId: repository.id,
    path,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
  };
  const symbol = stringField(row, ["symbol", "name", "signature"]);
  const language = stringField(row, ["language", "lang"]);
  const providerScore = numberField(row, ["score", "rrf_score", "similarity", "provider_score"]);
  const summary = stringField(row, ["summary"]);
  const preview = stringField(row, ["preview", "snippet", "summary", "text", "signature", "content"]);
  return {
    rank: numberField(row, ["rank"]) ?? options.rank,
    repositoryId: repository.id,
    repositoryName: repository.name,
    ...(repository.snapshot.headCommit ? { revision: repository.snapshot.headCommit } : {}),
    path,
    ...(reference.startLine === undefined ? {} : { startLine: reference.startLine }),
    ...(reference.endLine === undefined ? {} : { endLine: reference.endLine }),
    ...(symbol === undefined ? {} : { symbol }),
    ...(language === undefined ? {} : { language }),
    retrievalMethods: [actualMode],
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
        includeTests: query.includeTests,
        includeGenerated: query.includeGenerated,
      },
      enforcedFilters: options.enforcedFilters,
    }),
  };
}

function referenceFromRow(row: Record<string, unknown>, workspace: CodeWorkspace, provider: string): CodeReference {
  const project = stringField(row, ["project", "repository", "repo", "alias"]);
  const path = stringField(row, ["path", "file", "file_path", "relative_path"]) ?? "unknown";
  const repository = resolveRepository(workspace, project, path);
  const chunkId = String(row.chunk_id ?? row.chunkId ?? row.id ?? `${project ?? repository.id}:${path}`);
  const startLine = numberField(row, ["start_line", "startLine", "line_start"]);
  const endLine = numberField(row, ["end_line", "endLine", "line_end"]);
  return {
    provider,
    opaqueId: encodeReference({ chunkId, ...(project === undefined ? {} : { project }) }),
    repositoryId: repository.id,
    path,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
  };
}

function resolveRepository(workspace: CodeWorkspace, project?: string, path?: string) {
  if (project) {
    const match = workspace.repositories.find((repo) => repo.id === project || repo.name === project || basename(repo.root) === project);
    if (match) return match;
  }
  if (path) {
    const namespaced = workspace.repositories.find((repo) => path.startsWith(`${repo.name}/`) || path.startsWith(`${basename(repo.root)}/`));
    if (namespaced) return namespaced;
  }
  return workspace.repositories[0] ?? { id: "unknown", name: project ?? "unknown", root: "", snapshot: { repositoryId: "unknown", workspaceId: workspace.id, vcs: "git" as const, headCommit: "unknown", dirtyGeneration: 0, dirtyFingerprint: "unknown", indexSchemaVersion: 1 } };
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
    postProcessing: ["normalized by Atelier codesearch adapter"],
    reranked: false,
  };
}

function inferIndexState(data: unknown, fallback: CodeIndexState = "unknown"): CodeIndexState {
  const record = isRecord(data) ? data : {};
  const raw = stringField(record, ["index_state", "indexState", "state", "status"])?.toLowerCase();
  if (raw?.includes("build") || raw?.includes("indexing")) return "building";
  if (raw?.includes("stale")) return "stale";
  if (raw?.includes("fail") || raw?.includes("error")) return "failed";
  if (raw?.includes("missing") || raw?.includes("not found") || raw?.includes("unindexed")) return "missing";
  if (raw?.includes("ready") || raw?.includes("current") || raw?.includes("indexed") || raw?.includes("ok")) return "ready";
  if (typeof record.index_age_seconds === "number") return "ready";
  const text = stringField(record, ["text"])?.toLowerCase();
  if (text?.includes("not indexed")) return "missing";
  if (text?.includes("stale")) return "stale";
  if (text?.includes("indexed") || text?.includes("ready")) return "ready";
  return fallback;
}

function encodeReference(data: CodesearchReferenceData): string {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

function decodeReference(value: string): CodesearchReferenceData {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CodesearchReferenceData;
    if (!parsed || typeof parsed.chunkId !== "string") throw new Error("invalid reference");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
