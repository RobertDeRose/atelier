import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REPORT_ENTRY_TYPE = "atelier-report";
const CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const TUI_PACKAGE = "@earendil-works/pi-tui";

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

function packageEntry(packageRoot: string, packageJson: Record<string, unknown>): string {
  const exportsValue = packageJson.exports;
  if (typeof exportsValue === "string") return resolve(packageRoot, exportsValue);
  if (exportsValue !== null && typeof exportsValue === "object") {
    const dot = (exportsValue as Record<string, unknown>)["."];
    if (typeof dot === "string") return resolve(packageRoot, dot);
    if (dot !== null && typeof dot === "object") {
      const imported = (dot as Record<string, unknown>).import;
      if (typeof imported === "string") return resolve(packageRoot, imported);
    }
  }
  if (typeof packageJson.main === "string") return resolve(packageRoot, packageJson.main);
  return resolve(packageRoot, "dist", "index.js");
}

async function runtimeFromCodingAgentPackage(packageJsonPath: string): Promise<MarkdownRuntime> {
  const packageRoot = dirname(packageJsonPath);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
  const codingAgent = await import(pathToFileURL(packageEntry(packageRoot, packageJson)).href) as Record<string, unknown>;
  const requireFromHost = createRequire(pathToFileURL(packageJsonPath).href);
  const tuiEntry = requireFromHost.resolve(TUI_PACKAGE);
  const tui = await import(pathToFileURL(tuiEntry).href) as Record<string, unknown>;

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

export async function loadPiMarkdownRuntime(): Promise<MarkdownRuntime> {
  const errors: string[] = [];

  // First allow normal Pi package resolution. Pi's extension loader provides
  // its core packages for standard imports when the extension is installed as
  // a Pi package.
  try {
    const extensionRequire = createRequire(import.meta.url);
    const codingAgentEntry = extensionRequire.resolve(CODING_AGENT_PACKAGE);
    const tuiEntry = extensionRequire.resolve(TUI_PACKAGE);
    const [codingAgent, tui] = await Promise.all([
      import(pathToFileURL(codingAgentEntry).href) as Promise<Record<string, unknown>>,
      import(pathToFileURL(tuiEntry).href) as Promise<Record<string, unknown>>,
    ]);
    if (typeof tui.Markdown === "function" && typeof codingAgent.getMarkdownTheme === "function") {
      return {
        Markdown: tui.Markdown as MarkdownConstructor,
        getMarkdownTheme: codingAgent.getMarkdownTheme as () => unknown,
      };
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
    `Unable to load Pi Markdown runtime from the extension or Pi installation. ` +
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
