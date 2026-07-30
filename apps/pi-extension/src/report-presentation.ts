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

let MarkdownComponent: MarkdownConstructor | undefined;
let markdownTheme: (() => unknown) | undefined;

if (process.stdout.isTTY === true && process.env.TERM !== undefined) {
  try {
    const [tui, codingAgent] = await Promise.all([
      import("@earendil-works/pi-tui"),
      import("@earendil-works/pi-coding-agent"),
    ]);
    MarkdownComponent = tui.Markdown as MarkdownConstructor;
    markdownTheme = codingAgent.getMarkdownTheme as () => unknown;
  } catch {
    // Older Pi hosts may not expose the Markdown renderer. The fallback keeps
    // report rendering functional without loading terminal packages eagerly.
  }
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

function fallbackMarkdown(markdown: string): ReportComponent {
  return {
    render(width: number): string[] {
      return markdown.split(/\r?\n/).flatMap((line) => wrapLine(line, Math.max(1, width)));
    },
    invalidate(): void {},
  };
}

function markdownComponent(markdown: string): ReportComponent {
  if (MarkdownComponent === undefined || markdownTheme === undefined) return fallbackMarkdown(markdown);
  return new MarkdownComponent(markdown, 1, 0, markdownTheme());
}

export function registerAtelierReportRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer?.<AtelierReportEntry>(REPORT_ENTRY_TYPE, (entry) => {
    const data = entry.data;
    if (data === undefined || typeof data.markdown !== "string") return undefined;
    return markdownComponent(data.markdown);
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
