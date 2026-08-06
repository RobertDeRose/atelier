import { sha256 } from "../util/hash.ts";
import { redactValue } from "../security/redaction.ts";

export const CONTEXT_CAPSULE_VERSION = 1 as const;

export interface ContextCapsuleBudgets {
  /** Maximum UTF-8 bytes retained across section payloads. */
  maxBytes: number;
  /** Maximum UTF-8 bytes retained in the human/model-readable rendering. */
  maxOutputBytes: number;
  /** Maximum number of ordinary array items retained per section. */
  maxItems: number;
  /** Maximum history entries retained from a history section. */
  maxHistory: number;
  /** Maximum code-intelligence/retrieval entries retained from a retrieval section. */
  maxRetrieval: number;
}

export const DEFAULT_CONTEXT_CAPSULE_BUDGETS: ContextCapsuleBudgets = {
  maxBytes: 64_000,
  maxOutputBytes: 64_000,
  maxItems: 32,
  maxHistory: 20,
  maxRetrieval: 8,
};

export type ContextCapsuleFreshness = "current" | "stale" | "unknown" | "unavailable";

export interface ContextCapsuleSource {
  /** Stable adapter/source identifier, never an untrusted display label. */
  id: string;
  /** Authority that supplied the material, for example beads or document. */
  kind: string;
  /** Digest of the exact source material or source record. */
  digest: string;
  /** Path, task id, record id, or other exact source location. */
  location?: string;
  /** Boundary within the source that was read. */
  boundary?: string;
  freshness: ContextCapsuleFreshness;
}

export interface ContextCapsuleSectionInput {
  name: string;
  kind: string;
  sources: readonly ContextCapsuleSource[];
  value: unknown;
  /** Selects the history/retrieval-specific item budget for arrays in this section. */
  budgetClass?: "items" | "history" | "retrieval";
}

export interface ContextCapsuleSection {
  name: string;
  kind: string;
  sources: ContextCapsuleSource[];
  /** The source digest, or a stable aggregate when several sources contribute. */
  sourceDigest: string;
  value?: unknown;
  bytes: number;
  itemCount: number;
  omitted: string[];
  truncated: boolean;
}

export interface ContextCapsule {
  version: typeof CONTEXT_CAPSULE_VERSION;
  /** Digest of the immutable task/repository/source boundary used to build this capsule. */
  boundaryDigest: string;
  /** Digest of the bounded, redacted capsule content. */
  digest: string;
  budgets: ContextCapsuleBudgets;
  sections: ContextCapsuleSection[];
  omissions: string[];
  truncated: boolean;
  /** Human/model-readable bounded rendering of the same capsule. */
  markdown: string;
  /** True only when an unchanged capsule was returned by ContextCapsuleCache. */
  reused: boolean;
}

export interface ContextCapsuleBuildInput {
  /** Immutable task, repository, snapshot, grant, and provider boundary. */
  boundary: unknown;
  sections: readonly ContextCapsuleSectionInput[];
  budgets?: Partial<ContextCapsuleBudgets>;
  omissions?: readonly string[];
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function resolveBudgets(input: Partial<ContextCapsuleBudgets> | undefined): ContextCapsuleBudgets {
  return {
    maxBytes: positiveInteger(input?.maxBytes, DEFAULT_CONTEXT_CAPSULE_BUDGETS.maxBytes),
    maxOutputBytes: positiveInteger(input?.maxOutputBytes, DEFAULT_CONTEXT_CAPSULE_BUDGETS.maxOutputBytes),
    maxItems: positiveInteger(input?.maxItems, DEFAULT_CONTEXT_CAPSULE_BUDGETS.maxItems),
    maxHistory: positiveInteger(input?.maxHistory, DEFAULT_CONTEXT_CAPSULE_BUDGETS.maxHistory),
    maxRetrieval: positiveInteger(input?.maxRetrieval, DEFAULT_CONTEXT_CAPSULE_BUDGETS.maxRetrieval),
  };
}

/** JSON with stable object-key ordering; array order remains semantically meaningful. */
export function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return item;
  };
  const serialized = JSON.stringify(normalize(value));
  return serialized === undefined ? "null" : serialized;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLength(value) <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && byteLength(value.slice(0, end)) > maxBytes) end -= 1;
  return value.slice(0, end);
}

function itemLimit(section: ContextCapsuleSectionInput, budgets: ContextCapsuleBudgets): number {
  if (section.budgetClass === "history") return budgets.maxHistory;
  if (section.budgetClass === "retrieval") return budgets.maxRetrieval;
  return budgets.maxItems;
}

function boundNestedArrays(
  value: unknown,
  limit: number,
  omissions: string[],
  path: string,
): { value: unknown; truncated: boolean } {
  if (Array.isArray(value)) {
    const truncated = value.length > limit;
    if (truncated) {
      omissions.push(`${value.length - limit} entries omitted at ${path || "section"} by item budget`);
    }
    const retained = value.slice(0, limit).map((item, index) =>
      boundNestedArrays(item, limit, omissions, `${path}[${index}]`),
    );
    return {
      value: retained.map((item) => item.value),
      truncated: truncated || retained.some((item) => item.truncated),
    };
  }
  if (value !== null && typeof value === "object") {
    let truncated = false;
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const bounded = boundNestedArrays(item, limit, omissions, path ? `${path}.${key}` : key);
      truncated ||= bounded.truncated;
      return [key, bounded.value] as const;
    });
    return { value: Object.fromEntries(entries), truncated };
  }
  return { value, truncated: false };
}

interface BoundedValue {
  value?: unknown;
  bytes: number;
  itemCount: number;
  omitted: string[];
  truncated: boolean;
}

function encoded(value: unknown): string {
  return stableJson(value);
}

function fitValueToBytes(value: unknown, maxBytes: number): { value?: unknown; bytes: number; truncated: boolean } {
  if (maxBytes <= 0) return { bytes: 0, truncated: true };
  const serialized = encoded(value);
  if (byteLength(serialized) <= maxBytes) return { value, bytes: byteLength(serialized), truncated: false };

  if (typeof value === "string") {
    // JSON string quotes consume two bytes for the common case. Recheck after UTF-8 truncation.
    const candidate = truncateUtf8(value, Math.max(0, maxBytes - 2));
    if (byteLength(encoded(candidate)) <= maxBytes) {
      return { value: candidate, bytes: byteLength(encoded(candidate)), truncated: true };
    }
  }

  if (Array.isArray(value)) {
    const retained: unknown[] = [];
    for (const item of value) {
      const candidate = [...retained, item];
      if (byteLength(encoded(candidate)) > maxBytes) break;
      retained.push(item);
    }
    if (retained.length > 0 || maxBytes >= 2) {
      return { value: retained, bytes: byteLength(encoded(retained)), truncated: true };
    }
  }

  if (value !== null && typeof value === "object") {
    const retained: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
      const candidate = { ...retained, [key]: item };
      if (byteLength(encoded(candidate)) > maxBytes) break;
      Object.assign(retained, { [key]: item });
    }
    if (Object.keys(retained).length > 0 || maxBytes >= 2) {
      return { value: retained, bytes: byteLength(encoded(retained)), truncated: true };
    }
  }

  return { bytes: 0, truncated: true };
}

function boundSection(
  section: ContextCapsuleSectionInput,
  budgets: ContextCapsuleBudgets,
  availableBytes: number,
): BoundedValue {
  const omissions: string[] = [];
  let truncated = false;
  let redacted: unknown;
  try {
    redacted = redactValue(section.value);
  } catch {
    return {
      bytes: 0,
      itemCount: 0,
      omitted: ["section value could not be represented safely"],
      truncated: true,
    };
  }

  const nested = boundNestedArrays(redacted, itemLimit(section, budgets), omissions, section.name);
  let bounded = nested.value;
  let itemCount = Array.isArray(bounded) ? bounded.length : 1;
  truncated ||= nested.truncated;

  const fitted = fitValueToBytes(bounded, availableBytes);
  if (fitted.truncated) {
    truncated = true;
    if (!omissions.some((item) => item.includes("byte budget"))) {
      omissions.push("section content truncated by byte budget");
    }
  }
  if (fitted.value === undefined) omissions.push("section content omitted by byte budget");
  if (Array.isArray(fitted.value)) itemCount = fitted.value.length;

  return {
    ...(fitted.value === undefined ? {} : { value: fitted.value }),
    bytes: fitted.bytes,
    itemCount,
    omitted: omissions,
    truncated,
  };
}

function sourceDigest(sources: readonly ContextCapsuleSource[]): string {
  if (sources.length === 1 && sources[0]) return sources[0].digest;
  return sha256(stableJson(sources));
}

function renderMarkdown(capsule: Omit<ContextCapsule, "markdown">): string {
  const lines = [
    `# Context capsule ${capsule.digest}`,
    `- version: ${capsule.version}`,
    `- boundary: ${capsule.boundaryDigest}`,
    `- reused: ${capsule.reused}`,
    `- truncated: ${capsule.truncated}`,
  ];
  if (capsule.omissions.length > 0) {
    lines.push("- omissions:");
    for (const omission of capsule.omissions) lines.push(`  - ${omission}`);
  }
  for (const section of capsule.sections) {
    lines.push(`\n## ${section.name} (${section.kind})`);
    lines.push(`- source digest: ${section.sourceDigest}`);
    lines.push(`- bytes: ${section.bytes}; items: ${section.itemCount}; truncated: ${section.truncated}`);
    for (const source of section.sources) {
      const location = [source.location, source.boundary].filter(Boolean).join(" / ") || "unspecified";
      lines.push(`- source: ${source.id} (${source.freshness}) at ${location}`);
    }
    for (const omission of section.omitted) lines.push(`- omission: ${omission}`);
    if (section.value !== undefined) {
      lines.push("```json");
      lines.push(stableJson(section.value));
      lines.push("```");
    }
  }
  return lines.join("\n");
}

export function contextBoundaryDigest(boundary: unknown): string {
  return sha256(stableJson(redactValue(boundary)));
}

export function buildContextCapsule(input: ContextCapsuleBuildInput): ContextCapsule {
  const budgets = resolveBudgets(input.budgets);
  const boundaryDigest = contextBoundaryDigest(input.boundary);
  const omissions = [...(input.omissions ?? [])];
  const sections: ContextCapsuleSection[] = [];
  let remainingBytes = budgets.maxBytes;
  let truncated = false;

  for (const inputSection of input.sections) {
    if (inputSection.sources.length === 0) {
      throw new TypeError(`Context capsule section ${inputSection.name} must identify at least one source.`);
    }
    for (const source of inputSection.sources) {
      if (!source.id || !source.kind || !source.digest || !source.freshness) {
        throw new TypeError(`Context capsule section ${inputSection.name} contains an incomplete source descriptor.`);
      }
    }
    const bounded = boundSection(inputSection, budgets, remainingBytes);
    const section: ContextCapsuleSection = {
      name: inputSection.name,
      kind: inputSection.kind,
      sources: inputSection.sources.map((source) => ({ ...source })),
      sourceDigest: sourceDigest(inputSection.sources),
      ...(bounded.value === undefined ? {} : { value: bounded.value }),
      bytes: bounded.bytes,
      itemCount: bounded.itemCount,
      omitted: bounded.omitted,
      truncated: bounded.truncated,
    };
    sections.push(section);
    remainingBytes -= bounded.bytes;
    if (bounded.truncated) truncated = true;
    if (bounded.omitted.length > 0) {
      for (const omission of bounded.omitted) omissions.push(`${inputSection.name}: ${omission}`);
    }
  }

  let content = {
    version: CONTEXT_CAPSULE_VERSION,
    boundaryDigest,
    budgets,
    sections,
    omissions,
    truncated,
  };
  let digest = sha256(stableJson(content));
  let withoutMarkdown: Omit<ContextCapsule, "markdown"> = {
    ...content,
    digest,
    reused: false,
  };
  let rendered = renderMarkdown(withoutMarkdown);
  if (byteLength(rendered) > budgets.maxOutputBytes) {
    content = {
      ...content,
      omissions: [...content.omissions, "rendered Markdown truncated by output budget"],
      truncated: true,
    };
    digest = sha256(stableJson(content));
    withoutMarkdown = {
      ...content,
      digest,
      reused: false,
    };
    rendered = renderMarkdown(withoutMarkdown);
  }
  const markdown = truncateUtf8(rendered, budgets.maxOutputBytes);
  return { ...withoutMarkdown, markdown, reused: false };
}

function cloneCapsule(capsule: ContextCapsule): ContextCapsule {
  return structuredClone(capsule);
}

export class ContextCapsuleCache {
  private cached: { key: string; capsule: ContextCapsule } | undefined;

  getOrBuild(key: string, build: () => ContextCapsule): ContextCapsule {
    if (this.cached?.key === key) {
      const reused = cloneCapsule(this.cached.capsule);
      reused.reused = true;
      return reused;
    }
    const capsule = cloneCapsule({ ...build(), reused: false });
    this.cached = { key, capsule };
    return cloneCapsule(capsule);
  }

  clear(): void {
    this.cached = undefined;
  }
}
