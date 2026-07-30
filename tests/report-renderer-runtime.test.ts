import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerAtelierReportRenderer,
  type MarkdownRuntime,
} from "../apps/pi-extension/src/report-presentation.ts";

class FakePiMarkdown {
  static constructed = 0;
  readonly content: string;

  constructor(content: string, _paddingX: number, _paddingY: number, _theme: unknown) {
    FakePiMarkdown.constructed += 1;
    this.content = content;
  }

  render(_width: number): string[] {
    return this.content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => line
        .replace(/^#{1,6}\s+/, "")
        .replaceAll("**", "")
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .trim());
  }

  invalidate(): void {}
}

test("persistent reports instantiate Pi's Markdown component instead of rendering raw source", () => {
  let renderer: ((entry: any, options: any, theme: any) => any) | undefined;
  const pi = {
    registerEntryRenderer(_type: string, candidate: typeof renderer): void {
      renderer = candidate;
    },
  } as unknown as ExtensionAPI;
  const runtime: MarkdownRuntime = {
    Markdown: FakePiMarkdown,
    getMarkdownTheme: () => ({ source: "pi" }),
  };

  registerAtelierReportRenderer(pi, runtime);
  assert.ok(renderer);
  const component = renderer!({
    type: "custom",
    customType: "atelier-report",
    data: {
      title: "Status",
      markdown: "## Atelier status\n\n| field | value |\n|---|---|\n| **mode** | `act` |",
      createdAt: new Date(0).toISOString(),
    },
  }, { expanded: true }, {});
  const output = component.render(100).join("\n");

  assert.equal(FakePiMarkdown.constructed, 1);
  assert.match(output, /Atelier status/);
  assert.doesNotMatch(output, /^##/m);
  assert.doesNotMatch(output, /\*\*mode\*\*/);
});

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPiMarkdownRuntime } from "../apps/pi-extension/src/report-presentation.ts";

test("Markdown runtime resolves Pi host dependencies through the launched Pi executable", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-pi-markdown-host-"));
  const packageRoot = join(root, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  const tuiRoot = join(root, "lib", "node_modules", "@earendil-works", "pi-tui");
  const binRoot = join(root, "bin");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  mkdirSync(tuiRoot, { recursive: true });
  mkdirSync(binRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    type: "module",
    exports: "./dist/index.js",
  }));
  writeFileSync(join(packageRoot, "dist", "index.js"), "export const getMarkdownTheme = () => ({ host: true });\n");
  writeFileSync(join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(tuiRoot, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-tui",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(join(tuiRoot, "index.js"), "export class Markdown { render() { return ['host markdown']; } invalidate() {} }\n");
  symlinkSync(join(packageRoot, "dist", "cli.js"), join(binRoot, "pi"));

  const priorArgv = process.argv[1];
  process.argv[1] = join(binRoot, "pi");
  try {
    const runtime = await loadPiMarkdownRuntime();
    const component = new runtime.Markdown("# title", 0, 0, runtime.getMarkdownTheme());
    assert.deepEqual(component.render(80), ["host markdown"]);
  } finally {
    if (priorArgv === undefined) process.argv.splice(1, 1);
    else process.argv[1] = priorArgv;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Markdown runtime resolves mise's regular npm wrapper and lib/node_modules layout", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-pi-markdown-mise-"));
  const packageRoot = join(root, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  const tuiRoot = join(root, "lib", "node_modules", "@earendil-works", "pi-tui");
  const binRoot = join(root, "bin");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  mkdirSync(tuiRoot, { recursive: true });
  mkdirSync(binRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    type: "module",
    exports: { ".": { import: "./dist/index.js" } },
  }));
  writeFileSync(join(packageRoot, "dist", "index.js"), "export const getMarkdownTheme = () => ({ mise: true });\n");
  writeFileSync(join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(tuiRoot, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-tui",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(join(tuiRoot, "index.js"), "export class Markdown { render() { return ['mise markdown']; } invalidate() {} }\n");
  writeFileSync(join(binRoot, "pi"), `#!/bin/sh\nexec node "${join(packageRoot, "dist", "cli.js")}" "$@"\n`);

  const priorArgv = process.argv[1];
  const priorPath = process.env.PATH;
  process.argv[1] = join(binRoot, "pi");
  process.env.PATH = binRoot;
  try {
    const runtime = await loadPiMarkdownRuntime();
    const component = new runtime.Markdown("# title", 0, 0, runtime.getMarkdownTheme());
    assert.deepEqual(component.render(80), ["mise markdown"]);
  } finally {
    if (priorArgv === undefined) process.argv.splice(1, 1);
    else process.argv[1] = priorArgv;
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    rmSync(root, { recursive: true, force: true });
  }
});
