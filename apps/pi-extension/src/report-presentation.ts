import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REPORT_ENTRY_TYPE = "atelier-report";

interface ReportComponent {
  render(width: number): string[];
  invalidate(): void;
}

interface AtelierReportEntry {
  title: string;
  markdown: string;
  createdAt: string;
}

type MarkdownConstructor = new (
  content: string,
  paddingX: number,
  paddingY: number,
  theme: unknown,
) => ReportComponent;

export interface MarkdownRuntime {
  Markdown: MarkdownConstructor;
  getMarkdownTheme: () => unknown;
}

function moduleRequireCandidates(): ReturnType<typeof createRequire>[] {
  const candidates: ReturnType<typeof createRequire>[] = [createRequire(import.meta.url)];
  const argvEntry = process.argv[1];
  if (argvEntry !== undefined && existsSync(argvEntry)) {
    const hostEntry = realpathSync.native(argvEntry);
    candidates.push(createRequire(pathToFileURL(hostEntry).href));
  }
  // Pi's npm bin is commonly a symlink into the package. Resolve a require base
  // from every parent directory as a defensive fallback for alternative launchers.
  if (argvEntry !== undefined) {
    let current = dirname(resolve(argvEntry));
    for (let index = 0; index < 6; index += 1) {
      candidates.push(createRequire(pathToFileURL(resolve(current, "package.json")).href));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return candidates;
}

async function importFromPiHost(specifier: string): Promise<Record<string, unknown>> {
  const errors: string[] = [];
  for (const candidate of moduleRequireCandidates()) {
    try {
      const resolved = candidate.resolve(specifier);
      return await import(pathToFileURL(resolved).href) as Record<string, unknown>;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`Unable to resolve ${specifier} from the Atelier extension or Pi host: ${errors.at(-1) ?? "unknown error"}`);
}

export async function loadPiMarkdownRuntime(): Promise<MarkdownRuntime> {
  const [tui, codingAgent] = await Promise.all([
    importFromPiHost("@earendil-works/pi-tui"),
    importFromPiHost("@earendil-works/pi-coding-agent"),
  ]);
  if (typeof tui.Markdown !== "function") {
    throw new Error("Pi TUI did not export the Markdown component.");
  }
  if (typeof codingAgent.getMarkdownTheme !== "function") {
    throw new Error("Pi coding agent did not export getMarkdownTheme().");
  }
  return {
    Markdown: tui.Markdown as MarkdownConstructor,
    getMarkdownTheme: codingAgent.getMarkdownTheme as () => unknown,
  };
}

let markdownRuntime: MarkdownRuntime | undefined;
let markdownRuntimeError: string | undefined;
try {
  markdownRuntime = await loadPiMarkdownRuntime();
} catch (error) {
  markdownRuntimeError = error instanceof Error ? error.message : String(error);
}

function wrapLine(line: string, width: number): string[] {
  if (width <= 1 || line.length <= width) return [line.slice(0, Math.max(1, width))];
  const output: string[] = [];
  let remaining = line;
  while (remaining.length > width) {
    let split = remaining.lastIndexOf(" ", width);
    if (split <= 0) split = width;
    output.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  output.push(remaining);
  return output;
}

function fallbackMarkdown(markdown: string, diagnostic: string | undefined): ReportComponent {
  const prefix = diagnostic === undefined
    ? []
    : [`[Atelier Markdown renderer unavailable: ${diagnostic}]`, ""];
  return {
    render(width: number): string[] {
      return [...prefix, ...markdown.split(/\r?\n/)]
        .flatMap((line) => wrapLine(line, Math.max(1, width)));
    },
    invalidate(): void {},
  };
}

function markdownComponent(markdown: string, runtime: MarkdownRuntime | undefined): ReportComponent {
  if (runtime === undefined) return fallbackMarkdown(markdown, markdownRuntimeError);
  return new runtime.Markdown(markdown, 1, 0, runtime.getMarkdownTheme());
}

export function registerAtelierReportRenderer(
  pi: ExtensionAPI,
  runtime: MarkdownRuntime | undefined = markdownRuntime,
): void {
  pi.registerEntryRenderer?.<AtelierReportEntry>(REPORT_ENTRY_TYPE, (entry) => {
    const data = entry.data;
    if (data === undefined || typeof data.markdown !== "string") return undefined;
    return markdownComponent(data.markdown, runtime);
  });
}

export function appendAtelierReport(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  title: string,
  markdown: string,
): void {
  const entry: AtelierReportEntry = {
    title,
    markdown,
    createdAt: new Date().toISOString(),
  };
  if (typeof pi.appendEntry === "function") {
    pi.appendEntry(REPORT_ENTRY_TYPE, entry);
    return;
  }
  // Compatibility fallback for older Pi hosts and deterministic test doubles.
  ctx.ui.notify(markdown, "info");
}

export function markdownTable(rows: ReadonlyArray<readonly [string, string]>): string {
  return [
    "| field | value |",
    "|---|---|",
    ...rows.map(([field, value]) => `| **${field}** | ${value.replaceAll("|", "\\|")} |`),
  ].join("\n");
}

export function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}
