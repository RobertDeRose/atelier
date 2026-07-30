import { isSourcePath } from "../repository/source-path.ts";
import type { CodeSearchHit } from "./types.ts";

export type CodeResultCategory = "definition" | "source" | "test" | "docs" | "generated" | "other";

export function codeResultCategory(hit: Pick<CodeSearchHit, "path" | "symbol">): CodeResultCategory {
  const path = hit.path.replaceAll("\\", "/");
  const symbol = hit.symbol?.trim() ?? "";
  if (/(^|\/)(test|tests|spec|specs|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/.test(path)) return "test";
  if (/^(class|interface|type|enum|function|const|let|var|struct|trait|impl)\s+[A-Za-z_$][\w$]*/.test(symbol)) return "definition";
  if (/(^|\/)(docs?|documentation)(\/|$)|\.mdx?$/.test(path)) return "docs";
  if (/(^|\/)(dist|build|target|generated|vendor|node_modules)(\/|$)/.test(path)) return "generated";
  if (isSourcePath(path)) return "source";
  return "other";
}

export function usefulCodePreview(hit: Pick<CodeSearchHit, "preview" | "symbol">): string | undefined {
  const preview = hit.preview?.trim();
  if (preview && !/^(block|imports) \(\d+ lines?\)$/i.test(preview)) return preview;
  const symbol = hit.symbol?.trim();
  return symbol && !/^(block|imports) \(\d+ lines?\)$/i.test(symbol) ? symbol : undefined;
}

export function rankPresentedHits<T extends CodeSearchHit>(hits: readonly T[]): T[] {
  const priority: Record<CodeResultCategory, number> = { definition: 0, source: 1, test: 2, docs: 3, other: 4, generated: 5 };
  return [...hits].sort((left, right) => priority[codeResultCategory(left)] - priority[codeResultCategory(right)] || left.rank - right.rank)
    .map((hit, index) => ({ ...hit, rank: index + 1 }));
}
