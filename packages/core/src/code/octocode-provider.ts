import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sourceRevisionIdentity, sourceSnapshotBase } from "../repository/snapshot.ts";
import { createOpaqueIndexRevision } from "./canonical-query.ts";
import { McpStdioClient, type McpToolCallResult, type McpToolDefinition } from "./mcp-stdio-client.ts";
import { applyCodeSearchFocus, focusedProviderLimit, resolveCodeSearchFocus, type ResolvedCodeSearchFocus } from "./focus.ts";
import { UnsupportedCodeCapabilityError, type CodeProvider } from "./provider.ts";
import { ATELIER_VERSION } from "../version.ts";
import type {
  CodeCapability,
  CodeChunk,
  CodeIndexState,
  CodeProviderIdentity,
  CodeProviderStatus,
  CodeReference,
  CodeRelationship,
  CodeRelationshipQuery,
  CodeSearchHit,
  CodeSearchQuery,
  CodeSymbolQuery,
  CodeWorkspace,
} from "./types.ts";

interface OctocodeReferenceData {
  repositoryId: string;
  path: string;
  startLine?: number;
  endLine?: number;
  content?: string;
}

interface OctocodeClientState {
  client: McpStdioClient;
  tools: Map<string, McpToolDefinition>;
}

interface OctocodeStats {
  totalBlocks: number;
  codeModel?: string;
  textModel?: string;
  raw: string;
}

interface OctocodeVersionProbe {
  version?: string;
  error?: string;
}

export class OctocodeProvider implements CodeProvider {
  readonly name = "octocode";
  private readonly command: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly indexTimeoutMs: number;
  private readonly environment: Record<string, string>;
  private readonly clients = new Map<string, OctocodeClientState>();
  private identity: CodeProviderIdentity = { name: "octocode", instanceId: "octocode:experimental" };
  private indexedRevisions: Record<string, string> = {};
  private lastIndexedAt: string | undefined;
  private lastQueryAt: string | undefined;

  constructor(options: { command?: string; cwd: string; timeoutMs?: number; indexTimeoutMs?: number; environment?: Record<string, string> }) {
    this.command = options.command ?? "octocode";
    this.cwd = resolve(options.cwd);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.indexTimeoutMs = options.indexTimeoutMs ?? Math.max(this.timeoutMs, 30 * 60_000);
    this.environment = options.environment ?? {};
  }

  async status(workspace?: CodeWorkspace): Promise<CodeProviderStatus> {
    const versionProbe = this.probeVersion();
    const version = versionProbe.version;
    if (version === undefined) {
      return {
        identity: this.identity,
        available: false,
        healthy: false,
        capabilities: [],
        indexState: "missing",
        detail: [
          `Unable to execute ${this.command}: ${versionProbe.error ?? "version probe failed"}.`,
          "Install Muvon Octocode or configure octocodeCommand.",
        ].join(" "),
      };
    }
    this.identity = { name: "octocode", version, instanceId: "octocode:experimental" };
    if (workspace === undefined || workspace.repositories.length === 0) {
      return { identity: this.identity, available: true, healthy: true, capabilities: [], indexState: "unknown", detail: "Experimental provider; workspace capability discovery has not run." };
    }
    try {
      const stats = workspace.repositories.map((repository) => ({ repository, stats: this.inspectStats(repository.root) }));
      const configurationWarnings = stats.flatMap(({ repository, stats: value }) => {
        const issue = this.embeddingConfigurationIssue(value);
        return issue ? [`${repository.name}: ${issue}`] : [];
      });
      const states = await Promise.all(workspace.repositories.map((repository) => this.clientFor(repository.id, repository.root)));
      const capabilities = capabilitiesFor(states.flatMap((state) => [...state.tools.keys()]));
      const indexRevision = this.currentIndexRevision();
      if (indexRevision !== undefined) capabilities.push("index.revision_aware");
      const indexed = stats.every(({ stats: value }) => value.totalBlocks > 0);
      return {
        identity: this.identity,
        available: true,
        healthy: configurationWarnings.length === 0,
        capabilities,
        indexState: indexed ? "ready" : "missing",
        ...(indexRevision === undefined ? {} : { indexRevision }),
        detail: indexed
          ? `Octocode MCP available for ${states.length} repository process(es); searchable blocks verified.`
          : `Octocode MCP available for ${states.length} repository process(es), but one or more repositories have no searchable blocks.`,
        ...(configurationWarnings.length ? { degraded: true, warnings: configurationWarnings } : {}),
        ...(this.lastIndexedAt ? { lastIndexedAt: this.lastIndexedAt } : {}),
        ...(this.lastQueryAt ? { lastQueryAt: this.lastQueryAt } : {}),
        ...(Object.keys(this.indexedRevisions).length ? { indexedRevisions: this.indexedRevisions } : {}),
      };
    } catch (error) {
      return { identity: this.identity, available: true, healthy: false, capabilities: [], indexState: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async ensureIndex(workspace: CodeWorkspace): Promise<CodeIndexState> {
    const versionProbe = this.probeVersion();
    const version = versionProbe.version;
    if (version === undefined) {
      throw new Error(
        `octocode version probe failed for ${this.command}: ${versionProbe.error ?? "unknown error"}`,
      );
    }
    await this.close();
    for (const repository of workspace.repositories) {
      const before = this.inspectStats(repository.root);
      const configurationIssue = this.embeddingConfigurationIssue(before);
      if (configurationIssue) {
        throw new Error(`Octocode cannot index or search ${repository.root}: ${configurationIssue}`);
      }
      const indexArgs = ["index"];
      const result = spawnSync(this.command, indexArgs, {
        cwd: repository.root,
        env: { ...process.env, ...this.environment },
        encoding: "utf8",
        timeout: this.indexTimeoutMs,
        shell: false,
      });
      if (result.error || result.status !== 0) {
        throw new Error(`octocode index failed for ${repository.root}: ${result.stderr || result.stdout || result.error?.message || "unknown error"}`);
      }
      const after = this.inspectStats(repository.root);
      if (after.totalBlocks <= 0) {
        throw new Error(`Octocode index completed for ${repository.root} but produced no searchable blocks. ${this.embeddingConfigurationIssue(after) ?? "Run octocode stats and octocode clear before retrying if the existing index is unrecoverable."}`);
      }
      await this.clientFor(repository.id, repository.root);
    }
    this.indexedRevisions = Object.fromEntries(workspace.repositories.map((repository) => [
      repository.id,
      sourceRevisionIdentity(repository.snapshot),
    ]));
    this.lastIndexedAt = new Date().toISOString();
    return "ready";
  }

  async search(query: CodeSearchQuery): Promise<CodeSearchHit[]> {
    const repositories = selectedRepositories(query.workspace, query.repositoryIds);
    for (const repository of repositories) {
      const stats = this.inspectStats(repository.root);
      const issue = this.embeddingConfigurationIssue(stats);
      if (issue) throw new Error(`Octocode semantic search is unavailable for ${repository.root}: ${issue}`);
      if (stats.totalBlocks <= 0) throw new Error(`Octocode has no searchable blocks for ${repository.root}. Run atlr code index --provider octocode after configuring an embedding provider.`);
    }
    const resolvedFocus = resolveCodeSearchFocus(query.focus, query.text);
    const providerLimit = focusedProviderLimit(query.limit, resolvedFocus, query.mode);
    const all: CodeSearchHit[] = [];
    for (const repository of repositories) {
      const state = await this.clientFor(repository.id, repository.root);
      const tool = state.tools.get("semantic_search");
      if (!tool) throw new UnsupportedCodeCapabilityError("search.semantic", this.name);
      const input = buildSearchInput(tool, query, providerLimit, resolvedFocus);
      const result = await state.client.callTool("semantic_search", input);
      const error = toolResponseError(result);
      if (error) throw new Error(`Octocode semantic search failed: ${error}`);
      all.push(...normalizeHits(result, query, repository.id, repository.name, repository.root, this.identity));
    }
    this.lastQueryAt = new Date().toISOString();
    const providerRanked = all
      .sort((a, b) => (b.providerScore ?? 0) - (a.providerScore ?? 0))
      .map((hit, index) => ({ ...hit, rank: index + 1, providerRank: index + 1 }));
    const focused = applyCodeSearchFocus(providerRanked, query.focus, query.text);
    return focused.hits.slice(0, query.limit).map((hit, index) => ({
      ...hit,
      rank: index + 1,
      provenance: {
        ...hit.provenance,
        requestedFilters: { ...hit.provenance.requestedFilters, focus: query.focus ?? "auto", resolvedFocus: focused.focus },
        enforcedFilters: [...new Set([...hit.provenance.enforcedFilters, "content mode", ...(focused.focus === "all" ? [] : ["focus"])])],
        postProcessing: [
          ...hit.provenance.postProcessing,
          ...(providerLimit > query.limit ? [`overfetched up to ${providerLimit} Octocode results for ${focused.focus} focus`] : []),
          ...(focused.reranked ? [`reranked by ${focused.focus} focus with path diversification`] : []),
        ],
        reranked: focused.reranked,
      },
    }));
  }

  async read(reference: CodeReference): Promise<CodeChunk> {
    const data = decodeReference(reference.opaqueId);
    const repository = [...this.clients.keys()].includes(data.repositoryId) ? data.repositoryId : reference.repositoryId;
    const root = this.repositoryRoot(repository);
    if (!root) throw new Error(`Unknown Octocode repository: ${repository}`);
    const path = safePath(root, data.path);
    const content = data.content ?? readRange(path, data.startLine, data.endLine);
    return {
      reference,
      repositoryId: repository,
      path: relative(root, path),
      ...(data.startLine === undefined ? {} : { startLine: data.startLine }),
      ...(data.endLine === undefined ? {} : { endLine: data.endLine }),
      content,
      provenance: provenance(this.identity, repository, "", "semantic", this.indexedRevisions[repository]),
    };
  }

  async symbols(query: CodeSymbolQuery): Promise<CodeSearchHit[]> {
    const repositories = selectedRepositories(query.workspace, query.repositoryIds);
    const all: CodeSearchHit[] = [];
    for (const repository of repositories) {
      const stats = this.inspectStats(repository.root);
      const issue = this.embeddingConfigurationIssue(stats);
      if (issue) throw new Error(`Octocode symbol search is unavailable for ${repository.root}: ${issue}`);
      if (stats.totalBlocks <= 0) throw new Error(`Octocode has no searchable blocks for ${repository.root}. Run atlr code index --provider octocode.`);
      const state = await this.clientFor(repository.id, repository.root);
      const tool = state.tools.get("semantic_search");
      if (!tool) throw new UnsupportedCodeCapabilityError("symbol.search", this.name);
      const searchQuery: CodeSearchQuery = {
        workspace: query.workspace,
        text: query.text,
        mode: "semantic",
        focus: "source",
        literalHints: [`${query.text} symbol`, `${query.text} definition`],
        ...(query.repositoryIds ? { repositoryIds: query.repositoryIds } : {}),
        limit: Math.max(query.limit, 20),
        includeTests: true,
        includeGenerated: false,
      };
      const input = buildSearchInput(tool, searchQuery, Math.max(query.limit, 20), "source", { detailLevel: "signatures", threshold: 0 });
      const result = await state.client.callTool("semantic_search", input);
      const error = toolResponseError(result);
      if (error) throw new Error(`Octocode symbol search failed: ${error}`);
      all.push(...normalizeHits(result, searchQuery, repository.id, repository.name, repository.root, this.identity));
    }
    this.lastQueryAt = new Date().toISOString();
    const needle = query.text.toLowerCase();
    const ranked = all
      .sort((a, b) => {
        const aExact = `${a.symbol ?? ""} ${a.preview ?? ""} ${a.path}`.toLowerCase().includes(needle) ? 1 : 0;
        const bExact = `${b.symbol ?? ""} ${b.preview ?? ""} ${b.path}`.toLowerCase().includes(needle) ? 1 : 0;
        return bExact - aExact || (b.providerScore ?? 0) - (a.providerScore ?? 0);
      })
      .slice(0, query.limit);
    return ranked.map((hit, index) => ({ ...hit, rank: index + 1, providerRank: hit.providerRank ?? index + 1 }));
  }

  async relationships(query: CodeRelationshipQuery): Promise<CodeRelationship[]> {
    const repository = query.workspace.repositories.find((candidate) => candidate.id === query.reference.repositoryId);
    if (!repository) throw new Error(`Unknown repository: ${query.reference.repositoryId}`);
    const state = await this.clientFor(repository.id, repository.root);
    const tool = state.tools.get("graphrag");
    if (!tool) throw new UnsupportedCodeCapabilityError("graph.relationships", this.name);
    const input = buildRelationshipInput(tool, query.reference.path, query.limit, query.depth);
    const result = await state.client.callTool("graphrag", input);
    return normalizeRelationships(result, query, repository.root, this.identity);
  }

  async close(): Promise<void> {
    const states = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(states.map((state) => state.client.close()));
  }

  private roots = new Map<string, string>();

  private async clientFor(repositoryId: string, root: string): Promise<OctocodeClientState> {
    const existing = this.clients.get(repositoryId);
    if (existing) return existing;
    const client = new McpStdioClient(this.command, ["mcp", "--path", root], { cwd: root, timeoutMs: this.timeoutMs, environment: this.environment });
    const initialized = await client.initialize({ clientVersion: ATELIER_VERSION });
    const version = initialized.serverInfo.version ?? this.probeVersion().version;
    this.identity = { name: "octocode", instanceId: "octocode:experimental", ...(version ? { version } : {}) };
    const tools = new Map((await client.listTools()).map((tool) => [tool.name, tool]));
    const state = { client, tools };
    this.clients.set(repositoryId, state);
    this.roots.set(repositoryId, resolve(root));
    return state;
  }

  private repositoryRoot(repositoryId: string): string | undefined { return this.roots.get(repositoryId); }

  private inspectStats(root: string): OctocodeStats {
    const result = spawnSync(this.command, ["stats"], {
      cwd: root,
      env: { ...process.env, ...this.environment },
      encoding: "utf8",
      timeout: Math.min(this.timeoutMs, 30_000),
      shell: false,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`octocode stats failed for ${root}: ${result.stderr || result.stdout || result.error?.message || "unknown error"}`);
    }
    const raw = `${result.stdout}${result.stderr}`;
    const counts = ["Code blocks", "Text blocks", "Document blocks", "Commit blocks"]
      .map((label) => Number(raw.match(new RegExp(`${label}:\\s*([0-9,]+)`, "i"))?.[1]?.replaceAll(",", "") ?? "0"));
    const codeModel = raw.match(/Code model:\s*(\S+)/i)?.[1];
    const textModel = raw.match(/Text model:\s*(\S+)/i)?.[1];
    return { totalBlocks: counts.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0), ...(codeModel ? { codeModel } : {}), ...(textModel ? { textModel } : {}), raw };
  }

  private embeddingConfigurationIssue(stats: OctocodeStats): string | undefined {
    const model = stats.codeModel;
    if (!model) return undefined;
    const provider = model.split(":", 1)[0]?.toLowerCase();
    const required = provider === "voyage" ? "VOYAGE_API_KEY"
      : provider === "jina" ? "JINA_API_KEY"
      : provider === "google" ? "GOOGLE_API_KEY"
      : provider === "openai" ? "OPENAI_API_KEY"
      : provider === "octohub" ? "OCTOHUB_API_KEY"
      : provider === "together" ? "TOGETHER_API_KEY"
      : undefined;
    if (!required) return undefined;
    const environment = { ...process.env, ...this.environment };
    if (environment[required]?.trim()) return undefined;
    return `${required} is not set for configured code embedding model ${model}. Set the key, or install/configure an Octocode build with a local embedding provider.`;
  }

  private currentIndexRevision(): string | undefined {
    if (this.lastIndexedAt === undefined || Object.keys(this.indexedRevisions).length === 0) return undefined;
    return createOpaqueIndexRevision({
      provider: this.identity,
      indexedRevisions: this.indexedRevisions,
      indexedAt: this.lastIndexedAt,
    });
  }

  private probeVersion(): OctocodeVersionProbe {
    const result = spawnSync(this.command, ["--version"], {
      cwd: this.cwd,
      env: { ...process.env, ...this.environment },
      encoding: "utf8",
      timeout: Math.min(this.timeoutMs, 10_000),
      shell: false,
    });
    if (result.error) return { error: result.error.message };
    const output = `${result.stdout}${result.stderr}`.trim();
    if (result.status !== 0) {
      return { error: output || `process exited with status ${result.status ?? "unknown"}` };
    }
    const version = output.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0];
    return version === undefined
      ? { error: `version output did not contain a semantic version: ${output || "<empty>"}` }
      : { version };
  }
}

function capabilitiesFor(names: string[]): CodeCapability[] {
  const set = new Set(names);
  const capabilities: CodeCapability[] = ["index.repository", "index.multi_repository", "index.incremental", "result.fetch_on_demand"];
  if (set.has("semantic_search")) capabilities.push("search.semantic", "search.hybrid", "symbol.search");
  if (set.has("view_signatures")) capabilities.push("file.outline");
  if (set.has("graphrag")) capabilities.push("graph.relationships", "graph.imports", "graph.calls", "graph.dependencies", "symbol.references");
  return capabilities;
}

function selectedRepositories(workspace: CodeWorkspace, ids?: string[]) {
  if (!ids?.length) return workspace.repositories;
  const selected = new Set(ids);
  return workspace.repositories.filter((repository) => selected.has(repository.id));
}

function schemaProperties(tool: McpToolDefinition): Record<string, Record<string, unknown>> {
  const properties = tool.inputSchema?.properties;
  return properties && typeof properties === "object" ? properties as Record<string, Record<string, unknown>> : {};
}

function buildSearchInput(
  tool: McpToolDefinition,
  query: CodeSearchQuery,
  limit: number,
  focus: ResolvedCodeSearchFocus,
  options: { detailLevel?: "signatures" | "partial" | "full"; threshold?: number } = {},
): Record<string, unknown> {
  const properties = schemaProperties(tool);
  const input: Record<string, unknown> = {};
  const queryKey = ["query", "text", "prompt", "queries"].find((key) => key in properties) ?? "query";
  const terms = [...new Set([query.text, ...(query.literalHints ?? [])].map((value) => value.trim()).filter(Boolean))];
  const querySchema = properties[queryKey];
  const description = typeof querySchema?.description === "string" ? querySchema.description : "";
  const declaredType = querySchema?.type;
  const acceptsArray = queryKey === "queries"
    || declaredType === "array"
    || (Array.isArray(declaredType) && declaredType.includes("array"))
    || /array (?:of|string)|array preferred/i.test(description);
  input[queryKey] = acceptsArray ? terms : terms.join(" ");
  const limitKey = ["max_results", "limit", "top_k", "count"].find((key) => key in properties);
  if (limitKey) {
    const maximum = typeof properties[limitKey]?.maximum === "number" ? properties[limitKey]!.maximum as number : undefined;
    input[limitKey] = Math.max(1, Math.min(limit, maximum ?? limit));
  }
  if ("mode" in properties) input.mode = octocodeContentMode(focus);
  if ("detail_level" in properties) input.detail_level = options.detailLevel ?? "partial";
  if ("threshold" in properties && options.threshold !== undefined) input.threshold = options.threshold;
  if (query.languages?.length) {
    const languageKey = ["language", "lang", "languages"].find((key) => key in properties);
    if (languageKey) input[languageKey] = languageKey === "languages" ? query.languages : query.languages[0];
  }
  return input;
}

function octocodeContentMode(focus: ResolvedCodeSearchFocus): "code" | "docs" | "all" {
  if (focus === "docs") return "docs";
  if (focus === "source" || focus === "tests" || focus === "mixed") return "code";
  return "all";
}

function buildRelationshipInput(tool: McpToolDefinition, path: string, limit: number, depth: number): Record<string, unknown> {
  const properties = schemaProperties(tool);
  const input: Record<string, unknown> = {};
  const targetKey = ["node_id", "node", "target", "path", "file"].find((key) => key in properties) ?? "node_id";
  input[targetKey] = path;
  if ("action" in properties) input.action = enumChoice(properties.action, ["get-relationships", "relationships", "get_relationships"]);
  if ("operation" in properties) input.operation = enumChoice(properties.operation, ["get-relationships", "relationships", "get_relationships"]);
  if ("limit" in properties) input.limit = limit;
  if ("depth" in properties) input.depth = depth;
  return input;
}

function enumChoice(schema: Record<string, unknown> | undefined, preferred: string[]): string {
  const values = Array.isArray(schema?.enum) ? schema.enum.filter((value): value is string => typeof value === "string") : [];
  return preferred.find((value) => values.includes(value)) ?? values[0] ?? preferred[0]!;
}

function responseText(result: McpToolCallResult): string {
  return result.content?.map((item) => item.text).filter((value): value is string => typeof value === "string").join("\n") ?? "";
}

function payload(result: McpToolCallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = responseText(result);
  try { return JSON.parse(text); } catch { return { text }; }
}

function toolResponseError(result: McpToolCallResult): string | undefined {
  const text = result.content?.map((item) => item.text).filter((value): value is string => typeof value === "string").join("\n").trim() ?? "";
  if (result.isError === true) return text || "provider returned isError";
  if (/^(?:error|failed)\b/i.test(text)) return text;
  return undefined;
}

function candidateObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(candidateObjects);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const direct = [record];
  for (const key of ["results", "matches", "items", "nodes", "relationships", "data"]) {
    if (key in record) direct.push(...candidateObjects(record[key]));
  }
  return direct;
}

function normalizeHits(result: McpToolCallResult, query: CodeSearchQuery, repositoryId: string, repositoryName: string, root: string, identity: CodeProviderIdentity): CodeSearchHit[] {
  const seen = new Set<string>();
  const hits: CodeSearchHit[] = [];
  const candidates = candidateObjects(payload(result));
  candidates.push(...parseOctocodeHitText(responseText(result), query.text));
  for (const item of candidates) {
    const rawPath = stringValue(item, ["path", "file_path", "file", "filename", "source"]);
    if (!rawPath) continue;
    const path = isAbsolute(rawPath) ? relative(root, rawPath) : rawPath;
    const startLine = numberValue(item, ["start_line", "startLine", "line", "line_number"]);
    const endLine = numberValue(item, ["end_line", "endLine"]);
    const content = stringValue(item, ["content", "code", "snippet", "text", "preview"]);
    const key = `${path}:${startLine ?? ""}:${endLine ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const opaqueId = encodeReference({ repositoryId, path, ...(startLine === undefined ? {} : { startLine }), ...(endLine === undefined ? {} : { endLine }), ...(content ? { content } : {}) });
    const repository = query.workspace.repositories.find((repo) => repo.id === repositoryId);
    const sourceRevision = repository === undefined ? undefined : sourceSnapshotBase(repository.snapshot);
    hits.push({
      rank: hits.length + 1,
      providerRank: hits.length + 1,
      repositoryId,
      repositoryName,
      ...(sourceRevision === undefined ? {} : { revision: sourceRevision }),
      path,
      ...(startLine === undefined ? {} : { startLine }),
      ...(endLine === undefined ? {} : { endLine }),
      ...(stringValue(item, ["symbol", "name", "signature", "title"]) ? { symbol: stringValue(item, ["symbol", "name", "signature", "title"])! } : {}),
      retrievalMethods: ["semantic"],
      ...(numberValue(item, ["score", "similarity", "relevance"]) === undefined ? {} : { providerScore: numberValue(item, ["score", "similarity", "relevance"])! }),
      ...(content ? { preview: content } : {}),
      reference: { provider: "octocode", opaqueId, repositoryId, path, ...(startLine === undefined ? {} : { startLine }), ...(endLine === undefined ? {} : { endLine }) },
      provenance: provenance(identity, repositoryId, query.text, query.mode, sourceRevision),
    });
  }
  return hits;
}

function normalizeRelationships(result: McpToolCallResult, query: CodeRelationshipQuery, root: string, identity: CodeProviderIdentity): CodeRelationship[] {
  const relationships: CodeRelationship[] = [];
  const candidates = candidateObjects(payload(result));
  candidates.push(...parseOctocodeRelationshipText(responseText(result)));
  for (const item of candidates) {
    const rawPath = stringValue(item, ["target_path", "path", "file", "target", "to"]);
    if (!rawPath || rawPath === query.reference.path) continue;
    const path = isAbsolute(rawPath) ? relative(root, rawPath) : rawPath;
    const kind = relationshipKind(stringValue(item, ["relationship", "kind", "type", "edge"]));
    const target: CodeReference = { provider: "octocode", opaqueId: encodeReference({ repositoryId: query.reference.repositoryId, path }), repositoryId: query.reference.repositoryId, path };
    relationships.push({ kind, source: query.reference, target, ...(stringValue(item, ["label", "description", "name"]) ? { label: stringValue(item, ["label", "description", "name"])! } : {}), provenance: provenance(identity, query.reference.repositoryId, query.reference.path, "semantic") });
    if (relationships.length >= query.limit) break;
  }
  return relationships;
}


function parseOctocodeHitText(text: string, query: string): Record<string, unknown>[] {
  if (!text.trim()) return [];
  const semantic = parseSemanticResultText(text);
  if (semantic.length > 0) return semantic;
  return parseSignatureResultText(text, query);
}

function parseSemanticResultText(text: string): Record<string, unknown>[] {
  if (!/(?:CODE|DOC|TEXT|COMMIT) RESULTS \(\d+\)/i.test(text)) return [];
  const results: Record<string, unknown>[] = [];
  let current: { path: string; score?: number; startLine?: number; endLine?: number; lines: string[] } | undefined;
  const flush = (): void => {
    if (!current) return;
    results.push({
      path: current.path,
      ...(current.score === undefined ? {} : { score: current.score }),
      ...(current.startLine === undefined ? {} : { start_line: current.startLine }),
      ...(current.endLine === undefined ? {} : { end_line: current.endLine }),
      ...(current.lines.length ? { content: current.lines.join("\n") } : {}),
    });
    current = undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    const item = line.match(/^\s*\d+\.\s+(.+?)\s*$/);
    if (item) {
      flush();
      current = { path: item[1]!, lines: [] };
      continue;
    }
    if (!current) continue;
    const similarity = line.match(/Similarity\s+([0-9.]+)/i);
    if (similarity) {
      current.score = Number(similarity[1]);
      continue;
    }
    const source = line.match(/^\s*(\d+):\s?(.*)$/);
    if (source) {
      const lineNumber = Number(source[1]);
      current.startLine ??= lineNumber;
      current.endLine = lineNumber;
      current.lines.push(source[2] ?? "");
    }
  }
  flush();
  return results;
}

function parseSignatureResultText(text: string, query: string): Record<string, unknown>[] {
  if (!/^SIGNATURES \(/m.test(text)) return [];
  const sections = text.split(/(?=^FILE:\s+)/m).filter((section) => /^FILE:\s+/m.test(section));
  const needle = query.toLowerCase();
  return sections.flatMap((section) => {
    const path = section.match(/^FILE:\s+(.+)$/m)?.[1]?.trim();
    if (!path) return [];
    const sourceLines = [...section.matchAll(/^\s*(\d+):\s?(.*)$/gm)].map((match) => ({ line: Number(match[1]), text: match[2] ?? "" }));
    const matching = sourceLines.filter((item) => item.text.toLowerCase().includes(needle));
    const selected = matching.length ? matching : sourceLines.slice(0, 12);
    if (!selected.length) return [{ path }];
    return [{
      path,
      start_line: selected[0]!.line,
      end_line: selected.at(-1)!.line,
      content: selected.map((item) => item.text).join("\n"),
      ...(matching[0]?.text ? { signature: matching[0].text.trim() } : {}),
    }];
  });
}

function parseOctocodeRelationshipText(text: string): Record<string, unknown>[] {
  if (!text.trim()) return [];
  const results: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]?\s*(imports?|calls?|uses?|depends(?:_on)?|dependencies|references?)\s*(?:→|->|:|←)\s*([^:]+?)(?:\s*:\s*(.+))?$/i);
    if (!match) continue;
    const rawPath = match[2]!.trim().replace(/^['"`]|['"`]$/g, "");
    if (!/[/.]/.test(rawPath)) continue;
    results.push({ type: match[1], target_path: rawPath, ...(match[3] ? { description: match[3].trim() } : {}) });
  }
  return results;
}

function relationshipKind(value?: string): CodeRelationship["kind"] {
  const normalized = value?.toLowerCase() ?? "references";
  if (normalized.includes("import")) return "imports";
  if (normalized.includes("call")) return "calls";
  if (normalized.includes("depend")) return "dependencies";
  return "references";
}

function provenance(identity: CodeProviderIdentity, repositoryId: string, query: string, mode: "auto" | "lexical" | "semantic" | "hybrid", revision?: string) {
  return {
    provider: identity,
    workspaceId: "octocode",
    repositoryId,
    requestedMode: mode,
    actualMode: "semantic" as const,
    query,
    retrievedAt: new Date().toISOString(),
    indexState: "ready" as const,
    requestedFilters: {},
    enforcedFilters: ["repository process"],
    postProcessing: ["normalized by Atelier Octocode adapter"],
    reranked: false,
    ...(revision ? { freshness: "current" as const, indexedRevision: revision, currentRevision: revision } : { freshness: "unknown" as const }),
  };
}

function stringValue(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string;
  return undefined;
}
function numberValue(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) if (typeof record[key] === "number") return record[key] as number;
  return undefined;
}
function encodeReference(data: OctocodeReferenceData): string { return Buffer.from(JSON.stringify(data), "utf8").toString("base64url"); }
function decodeReference(value: string): OctocodeReferenceData { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as OctocodeReferenceData; }
function safePath(root: string, path: string): string {
  const resolved = resolve(root, path);
  const prefix = `${resolve(root)}${sep}`;
  if (resolved !== resolve(root) && !resolved.startsWith(prefix)) throw new Error(`Octocode reference escaped repository root: ${path}`);
  if (!existsSync(resolved)) throw new Error(`Octocode source path does not exist: ${path}`);
  return resolved;
}
function readRange(path: string, startLine?: number, endLine?: number): string {
  const content = readFileSync(path, "utf8");
  if (startLine === undefined) return content;
  const lines = content.split(/\r?\n/);
  return lines.slice(Math.max(0, startLine - 1), endLine ?? startLine).join("\n");
}
