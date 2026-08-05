import assert from "node:assert/strict";
import test from "node:test";
import { installAtelierFooter, renderAtelierFooter } from "../apps/pi-extension/src/status-presentation.ts";

function status(overrides: Record<string, unknown> = {}): any {
  return {
    mode: "investigate",
    workflowCheckpoint: "none",
    closureStatus: "not applicable — no active task",
    snapshot: { vcs: "jj", changeId: "abcdefgh123", headCommit: "12345678" },
    repositoryDisplay: { vcs: "jj", revision: "abcdefgh", state: "clean" },
    ...overrides,
  };
}

function context(percent = 42): any {
  return {
    mode: "tui",
    model: { id: "gpt-test" },
    getContextUsage: () => ({ percent }),
    ui: {},
  };
}

test("Atelier footer uses two aligned lines without duplicated workflow or VCS state", () => {
  const lines = renderAtelierFooter(context(), status(), "ready", 120, {}, "medium");
  assert.equal(lines.length, 2);
  const [line1 = "", line2 = ""] = lines;
  assert.match(line1, /^Atelier: gpt-test · medium · ctx 42%\s+mode: investigate$/);
  assert.match(line2, /^jj: abcdefgh · ✓ clean\s+intel: ready$/);
  assert.equal((lines.join("\n").match(/abcdefgh/g) ?? []).length, 1);
  assert.doesNotMatch(lines.join("\n"), /missing|no task|not applicable/i);
});

test("Atelier footer uses task titles when wide and Beads ids when narrow", () => {
  const active = status({
    mode: "act",
    workflowCheckpoint: "executing",
    currentTaskId: "repo-t0e",
    currentTaskTitle: "Add stable product-name constant",
    closureStatus: "blocked — Task closure blocked: the current diff has not been reviewed.",
    repositoryDisplay: { vcs: "jj", label: "main", revision: "rpnoyzpv", state: "dirty" },
  });
  const wide = renderAtelierFooter(context(74), active, "ready", 160, {}, "high");
  const [wide1 = "", wide2 = ""] = wide;
  assert.match(wide1, /task: Add stable product-name constant/);
  assert.match(wide1, /blocked: diff review/);
  assert.match(wide2, /^jj: main · rpnoyzpv · ● dirty\s+intel: ready$/);

  const narrow = renderAtelierFooter(context(74), active, "ready", 66, {}, "high");
  const [narrow1 = ""] = narrow;
  assert.match(narrow1, /task: repo-t0e/);
  assert.doesNotMatch(narrow1, /Add stable product-name/);
  assert.ok(narrow.every((line) => Array.from(line).length <= 66));
});

test("Atelier footer distinguishes active execution from closure blockers", () => {
  const active = status({
    mode: "act",
    workflowCheckpoint: "executing",
    currentTaskId: "repo-t0e",
    currentTaskTitle: "Continue the task",
    activeExecutionGrant: { status: "active" },
    closureStatus: "blocked — Task closure blocked: the current diff has not been reviewed.",
  });
  const [line = ""] = renderAtelierFooter(context(), active, "ready", 160, {}, "high");
  assert.match(line, /closure: diff review/);
  assert.doesNotMatch(line, /blocked: diff review/);
});

test("Atelier footer applies bold headings and semantic state colors", () => {
  const theme = {
    bold: (value: string) => `<b>${value}</b>`,
    fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
  };
  const lines = renderAtelierFooter(context(95), status({ repositoryDisplay: { vcs: "git", label: "main", revision: "12345678", state: "conflicted" } }), "offline", 180, theme, "low");
  const [line1 = "", line2 = ""] = lines;
  assert.match(line1, /<accent><b>Atelier:<\/b><\/accent>/);
  assert.match(line1, /<error>ctx 95%<\/error>/);
  assert.match(line2, /<accent><b>git:<\/b><\/accent>/);
  assert.match(line2, /<error>! conflicted<\/error>/);
  assert.match(line2, /<error>offline<\/error>/);
});


test("Atelier footer keeps durable mode state separate from transient progress", () => {
  const lines = renderAtelierFooter(
    context(),
    status(),
    "ready",
    160,
    {},
    "medium",
    "gpt-test",
  );
  assert.match(lines[0] ?? "", /mode: investigate/);
  assert.doesNotMatch(lines[0] ?? "", /preparing|reading|refreshing/);
});
test("status-only and disabled footer modes release Pi footer ownership", () => {
  const values: unknown[] = [];
  const ctx = { mode: "tui", ui: { setFooter: (value: unknown) => values.push(value) } } as any;
  installAtelierFooter(ctx, status(), "ready", undefined, "status-only");
  installAtelierFooter(ctx, status(), "ready", undefined, "disabled");
  assert.deepEqual(values, [undefined, undefined]);
});

test("Atelier footer keeps thinking levels readable and treats disabled intelligence as neutral", () => {
  const theme = {
    bold: (value: string) => `<b>${value}</b>`,
    fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
  };
  const lines = renderAtelierFooter(context(10), status(), "disabled", 160, theme, "high");
  const [runtime = "", provider = ""] = lines;
  assert.match(runtime, /high/);
  assert.doesNotMatch(runtime, /<dim>high<\/dim>/);
  assert.match(provider, /<muted>disabled<\/muted>/);
  assert.doesNotMatch(provider, /<error>disabled<\/error>/);
});
