import type { CodeSearchFocus, CodeSearchHit } from "./types.ts";

export type ResolvedCodeSearchFocus = Exclude<CodeSearchFocus, "auto"> | "mixed";
export type CodePathKind = "source" | "tests" | "docs" | "tooling" | "other";

const SOURCE_HINTS = /\b(?:implement(?:ed|ation)?|trace|handler|entry\s*point|call(?:er|ing|s)?|function|class|method|initialize|select(?:ion|ed|s)?|freshness|flow|dispatch|parse|invoke|construct|builds?|creates?|where\s+(?:is|are)|how\s+does|how\s+is)\b/i;
const TEST_HINTS = /\b(?:tests?|testing|verify|verifies|verification|regression|fixture|assert(?:ion|s)?)\b/i;
const DOC_HINTS = /\b(?:docs?|documentation|documented|adr|decision|rationale|design\s+document|why\s+(?:was|is|did)|proposal|architecture)\b/i;

const SOURCE_EXTENSIONS = new Set([
  "c", "cc", "cpp", "cxx", "cs", "ex", "exs", "go", "h", "hpp", "java", "js", "jsx",
  "kt", "kts", "lua", "m", "mm", "php", "pl", "pm", "py", "rb", "rs", "scala", "sh",
  "swift", "ts", "tsx", "vue", "zig",
]);

export function inferCodeSearchFocus(text: string): ResolvedCodeSearchFocus {
  const asksForTests = TEST_HINTS.test(text);
  const asksForSource = SOURCE_HINTS.test(text) || /[`][^`]+[`]/.test(text);
  if (asksForTests && asksForSource) return "mixed";
  if (asksForTests) return "tests";
  if (DOC_HINTS.test(text) && !SOURCE_HINTS.test(text)) return "docs";
  if (asksForSource) return "source";
  return "all";
}

export function resolveCodeSearchFocus(requested: CodeSearchFocus | undefined, text: string): ResolvedCodeSearchFocus {
  return requested === undefined || requested === "auto" ? inferCodeSearchFocus(text) : requested;
}

export function classifyCodePath(path: string): CodePathKind {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  const segments = normalized.split("/");
  const filename = segments.at(-1) ?? normalized;
  const extension = filename.includes(".") ? filename.split(".").at(-1) ?? "" : "";

  if (
    segments.some((segment) => ["test", "tests", "spec", "specs", "__tests__", "fixtures"].includes(segment))
    || /(?:^|[._-])(?:test|spec)\.[^.]+$/.test(filename)
  ) return "tests";

  if (
    segments.includes("docs")
    || ["readme.md", "changelog.md", "contributing.md", "architecture.md", "license.md"].includes(filename)
    || ["md", "mdx", "adoc", "rst"].includes(extension)
  ) return "docs";

  if (segments.some((segment) => ["scripts", "script", "tools", "tooling", "bin", ".github"].includes(segment))) return "tooling";
  if (SOURCE_EXTENSIONS.has(extension)) return "source";
  return "other";
}

export function focusedProviderLimit(finalLimit: number, focus: ResolvedCodeSearchFocus, _mode: string): number {
  if (focus === "all") return finalLimit;
  return 50;
}

export function applyCodeSearchFocus(
  hits: CodeSearchHit[],
  requested: CodeSearchFocus | undefined,
  text: string,
): { hits: CodeSearchHit[]; focus: ResolvedCodeSearchFocus; reranked: boolean } {
  const focus = resolveCodeSearchFocus(requested, text);
  if (focus === "all") return { hits, focus, reranked: false };

  const priority = (hit: CodeSearchHit): number => focusPriority(focus, classifyCodePath(hit.path));
  const sorted = [...hits].sort((left, right) => {
    const priorityDifference = priority(left) - priority(right);
    if (priorityDifference !== 0) return priorityDifference;
    return left.rank - right.rank;
  });

  const unique: CodeSearchHit[] = [];
  const duplicates: CodeSearchHit[] = [];
  const seen = new Set<string>();
  for (const hit of sorted) {
    const key = `${hit.repositoryId}:${hit.path}`;
    if (seen.has(key)) duplicates.push(hit);
    else {
      seen.add(key);
      unique.push(hit);
    }
  }

  const reranked = focus === "mixed"
    ? [...interleaveMixed(unique), ...duplicates]
    : [...unique, ...duplicates];
  return {
    hits: reranked.map((hit, index) => ({ ...hit, rank: index + 1 })),
    focus,
    reranked: reranked.some((hit, index) => hit.providerRank !== index + 1),
  };
}

export function rankCodePathsByFocus(
  paths: string[],
  requested: CodeSearchFocus | undefined,
  text: string,
): { paths: string[]; focus: ResolvedCodeSearchFocus; reranked: boolean } {
  const focus = resolveCodeSearchFocus(requested, text);
  const unique = [...new Set(paths)];
  if (focus === "all") return { paths: unique, focus, reranked: false };
  const indexed = unique.map((path, index) => ({ path, index }));
  indexed.sort((left, right) => {
    const priorityDifference = focusPriority(focus, classifyCodePath(left.path)) - focusPriority(focus, classifyCodePath(right.path));
    return priorityDifference !== 0 ? priorityDifference : left.index - right.index;
  });
  const ranked = focus === "mixed"
    ? interleaveMixed(indexed.map((item) => item.path)).map((item) => item)
    : indexed.map((item) => item.path);
  return { paths: ranked, focus, reranked: ranked.some((path, index) => path !== unique[index]) };
}

function focusPriority(focus: ResolvedCodeSearchFocus, kind: CodePathKind): number {
  if (focus === "mixed") {
    if (kind === "source" || kind === "tests") return 0;
    if (kind === "tooling" || kind === "other") return 1;
    return 2;
  }
  if (focus === "source") {
    if (kind === "source") return 0;
    if (kind === "tooling" || kind === "other") return 1;
    if (kind === "tests") return 2;
    return 3;
  }
  if (focus === "tests") {
    if (kind === "tests") return 0;
    if (kind === "source") return 1;
    if (kind === "tooling" || kind === "other") return 2;
    return 3;
  }
  if (kind === "docs") return 0;
  if (kind === "source") return 1;
  if (kind === "tests") return 2;
  return 3;
}

function interleaveMixed<T extends CodeSearchHit | string>(items: T[]): T[] {
  const sources: T[] = [];
  const tests: T[] = [];
  const remaining: T[] = [];
  for (const item of items) {
    const kind = classifyCodePath(typeof item === "string" ? item : item.path);
    if (kind === "source") sources.push(item);
    else if (kind === "tests") tests.push(item);
    else remaining.push(item);
  }
  const interleaved: T[] = [];
  while (sources.length > 0 || tests.length > 0) {
    const source = sources.shift();
    if (source !== undefined) interleaved.push(source);
    const test = tests.shift();
    if (test !== undefined) interleaved.push(test);
  }
  return [...interleaved, ...remaining];
}
