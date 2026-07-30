import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REPORT_ENTRY_TYPE = "atelier-report";
const TUI_PACKAGE = "@earendil-works/pi-tui";

interface ReportComponent {
  render(width: number): string[];
  invalidate(): void;
}

interface AtelierReportEntry {
  title: string;
  summary: string;
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
}

type PiRenderTheme = {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
  italic?: (text: string) => string;
  strikethrough?: (text: string) => string;
  underline?: (text: string) => string;
};

type MarkdownTheme = {
  heading: (text: string) => string;
  link: (text: string) => string;
  linkUrl: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  quote: (text: string) => string;
  quoteBorder: (text: string) => string;
  hr: (text: string) => string;
  listBullet: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  underline: (text: string) => string;
};

function addUniquePath(paths: string[], candidate: string): void {
  if (!paths.includes(candidate)) paths.push(candidate);
}

function packageJsonCandidatesForPrefix(paths: string[], prefix: string): void {
  addUniquePath(paths, join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
  addUniquePath(paths, join(prefix, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
}

function executableCandidates(): string[] {
  const candidates: string[] = [];
  if (process.argv[1] !== undefined) addUniquePath(candidates, resolve(process.argv[1]));
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, process.platform === "win32" ? "pi.cmd" : "pi");
    if (existsSync(candidate)) addUniquePath(candidates, candidate);
  }
  return candidates;
}

function packageJsonCandidates(): string[] {
  const candidates: string[] = [];
  for (const executable of executableCandidates()) {
    const effectiveExecutable = existsSync(executable)
      ? realpathSync.native(executable)
      : executable;
    for (const item of [executable, effectiveExecutable]) {
      let current = dirname(item);
      for (let index = 0; index < 8; index += 1) {
        packageJsonCandidatesForPrefix(candidates, current);
        addUniquePath(candidates, join(current, "package.json"));
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }

    // mise and other global npm wrappers are often regular scripts rather than
    // symlinks. Capture any absolute coding-agent package path embedded in the
    // wrapper as another authoritative package root.
    try {
      const wrapper = readFileSync(executable, "utf8");
      const matches = wrapper.matchAll(/(?:\/[^\s"']+)*\/lib\/node_modules\/@earendil-works\/pi-coding-agent(?:\/dist\/cli\.js)?/g);
      for (const match of matches) {
        const packageRoot = match[0]!.replace(/\/dist\/cli\.js$/, "");
        addUniquePath(candidates, join(packageRoot, "package.json"));
      }
    } catch {
      // Native binaries and unreadable wrappers simply contribute no embedded path.
    }
  }
  return candidates;
}

async function runtimeFromCodingAgentPackage(packageJsonPath: string): Promise<MarkdownRuntime> {
  const requireFromHost = createRequire(pathToFileURL(packageJsonPath).href);
  const tuiEntry = requireFromHost.resolve(TUI_PACKAGE);
  const tui = await import(pathToFileURL(tuiEntry).href) as Record<string, unknown>;

  if (typeof tui.Markdown !== "function") {
    throw new Error("Pi TUI did not export the Markdown component.");
  }
  return { Markdown: tui.Markdown as MarkdownConstructor };
}

export async function loadPiMarkdownRuntime(): Promise<MarkdownRuntime> {
  const errors: string[] = [];

  // First allow normal Pi package resolution. Pi's extension loader provides
  // its core packages for standard imports when the extension is installed as
  // a Pi package. The active renderer callback supplies the initialized Pi
  // theme, so only the TUI Markdown component must be resolved here.
  try {
    const extensionRequire = createRequire(import.meta.url);
    const tuiEntry = extensionRequire.resolve(TUI_PACKAGE);
    const tui = await import(pathToFileURL(tuiEntry).href) as Record<string, unknown>;
    if (typeof tui.Markdown === "function") {
      return { Markdown: tui.Markdown as MarkdownConstructor };
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  for (const packageJsonPath of packageJsonCandidates()) {
    if (!existsSync(packageJsonPath)) continue;
    try {
      return await runtimeFromCodingAgentPackage(packageJsonPath);
    } catch (error) {
      errors.push(`${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `Unable to load Pi Markdown component from the extension or Pi installation. ` +
    `Checked ${packageJsonCandidates().filter(existsSync).length} installed package root(s). ` +
    `${errors.at(-1) ?? "No Pi installation package was found."}`,
  );
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

function rendererMarkdownTheme(theme: unknown): MarkdownTheme {
  const piTheme = (theme ?? {}) as PiRenderTheme;
  const fg = (color: string, text: string): string => piTheme.fg?.(color, text) ?? text;
  return {
    heading: (text) => fg("mdHeading", text),
    link: (text) => fg("mdLink", text),
    linkUrl: (text) => fg("mdLinkUrl", text),
    code: (text) => fg("mdCode", text),
    codeBlock: (text) => fg("mdCodeBlock", text),
    codeBlockBorder: (text) => fg("mdCodeBlockBorder", text),
    quote: (text) => fg("mdQuote", text),
    quoteBorder: (text) => fg("mdQuoteBorder", text),
    hr: (text) => fg("mdHr", text),
    listBullet: (text) => fg("mdListBullet", text),
    bold: (text) => piTheme.bold?.(text) ?? text,
    italic: (text) => piTheme.italic?.(text) ?? text,
    strikethrough: (text) => piTheme.strikethrough?.(text) ?? text,
    underline: (text) => piTheme.underline?.(text) ?? text,
  };
}

function markdownComponent(
  markdown: string,
  runtime: MarkdownRuntime | undefined,
  theme: unknown,
): ReportComponent {
  if (runtime === undefined) return fallbackMarkdown(markdown, markdownRuntimeError);
  return new runtime.Markdown(markdown, 1, 0, rendererMarkdownTheme(theme));
}

function plainWidth(value: string): number {
  return Array.from(value).length;
}

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  const chars = Array.from(value);
  if (chars.length <= width) return value;
  if (width === 1) return "…";
  return `${chars.slice(0, width - 1).join("")}…`;
}

function reportTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function reportCard(
  entry: AtelierReportEntry,
  content: ReportComponent,
  expanded: boolean,
  theme: unknown,
): ReportComponent {
  const piTheme = (theme ?? {}) as PiRenderTheme;
  const fg = (color: string, text: string): string => piTheme.fg?.(color, text) ?? text;
  const bold = (text: string): string => piTheme.bold?.(text) ?? text;

  return {
    render(width: number): string[] {
      const safeWidth = Math.max(8, width);
      const divider = fg("border", "─".repeat(safeWidth));
      const arrow = expanded ? "▼" : "➤";
      const time = reportTime(entry.createdAt);
      const suffix = [entry.summary, time].filter(Boolean).join(" · ");
      const plainHeader = `${arrow} ${entry.title}${suffix === "" ? "" : ` · ${suffix}`}`;
      const visibleHeader = truncate(plainHeader, safeWidth);
      const styledPrefix = `${fg("accent", arrow)} ${fg("accent", bold(entry.title))}`;
      const remainder = visibleHeader.slice(plainWidth(`${arrow} ${entry.title}`));
      const header = `${styledPrefix}${fg("dim", remainder)}`;

      if (!expanded) return [divider, header, divider];
      return [divider, header, "", ...content.render(safeWidth), divider];
    },
    invalidate(): void {
      content.invalidate();
    },
  };
}

export function registerAtelierReportRenderer(
  pi: ExtensionAPI,
  runtime: MarkdownRuntime | undefined = markdownRuntime,
): void {
  pi.registerEntryRenderer?.<AtelierReportEntry>(REPORT_ENTRY_TYPE, (entry, options, theme) => {
    const data = entry.data;
    if (data === undefined || typeof data.markdown !== "string") return undefined;
    const normalized: AtelierReportEntry = {
      title: typeof data.title === "string" ? data.title : "Atelier report",
      summary: typeof data.summary === "string" ? data.summary : "",
      markdown: data.markdown,
      createdAt: typeof data.createdAt === "string" ? data.createdAt : new Date().toISOString(),
    };
    return reportCard(
      normalized,
      markdownComponent(normalized.markdown, runtime, theme),
      options.expanded,
      theme,
    );
  });
}

export function appendAtelierReport(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  title: string,
  markdown: string,
  summary = "",
): void {
  const entry: AtelierReportEntry = {
    title,
    summary,
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

export function markdownFields(rows: ReadonlyArray<readonly [string, string]>): string {
  return rows.map(([field, value]) => `**${field}:** ${value}`).join("  \n");
}

export function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}
