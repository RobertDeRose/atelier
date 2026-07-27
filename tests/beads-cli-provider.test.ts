import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BeadsCliTaskProvider, normalizeBeadsTask } from "../packages/core/src/tasks/beads-cli-provider.ts";
import { assertTaskProviderConformance } from "./task-provider-conformance.ts";

test("normalizes representative Beads JSON into Atelier task records", () => {
  const task = normalizeBeadsTask({
    id: "ATLR-abc",
    title: "Example",
    description: "Description",
    status: "in-progress",
    priority: "1",
    issue_type: "feature",
    dependencies: [{ depends_on_id: "ATLR-root" }],
    labels: ["atelier-plan"],
    acceptance_criteria: "One\nTwo",
    notes: "Atelier plan task: ATLR-001\n\nDurable notes",
  });

  assert.equal(task.status, "in_progress");
  assert.equal(task.priority, 1);
  assert.equal(task.type, "feature");
  assert.deepEqual(task.dependencies, ["ATLR-root"]);
  assert.deepEqual(task.acceptanceCriteria, ["One", "Two"]);
  assert.equal(task.planTaskId, "ATLR-001");
});

test("uses structured JSON commands without shell interpolation", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-beads-adapter-"));
  const executable = join(root, "fake-bd.mjs");
  const log = join(root, "commands.jsonl");
  const script = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const command = args[0];
if (command === "version") { console.log("bd test-1"); process.exit(0); }
if (command === "where") { console.log(JSON.stringify({ root: process.cwd() })); process.exit(0); }
if (command === "ready") { console.log(JSON.stringify([{ id: "bd-1", title: "Ready", status: "open", priority: 1, issue_type: "task" }])); process.exit(0); }
if (command === "create") { console.log(JSON.stringify({ id: "bd-created", title: args[1], description: args[args.indexOf("--description") + 1], status: "open", priority: 1, issue_type: "task", labels: ["atelier-plan"] })); process.exit(0); }
if (command === "update") { console.log(JSON.stringify({ id: args[1], title: "Updated", status: args.includes("--claim") ? "in_progress" : "open", priority: 1, issue_type: "task" })); process.exit(0); }
if (command === "dep") { console.log(JSON.stringify({ ok: true })); process.exit(0); }
if (command === "close") { console.log(JSON.stringify({ id: args[1], title: "Closed", status: "closed", priority: 1, issue_type: "task" })); process.exit(0); }
if (command === "show") { console.log(JSON.stringify({ id: args[1], title: "Shown", status: "open", priority: 1, issue_type: "task" })); process.exit(0); }
if (command === "list") { console.log("[]"); process.exit(0); }
console.error("unsupported", args); process.exit(2);
`;
  writeFileSync(executable, script, "utf8");
  chmodSync(executable, 0o755);

  const provider = new BeadsCliTaskProvider({ cwd: root, executable });
  try {
    const status = await provider.status();
    assert.equal(status.available, true);
    assert.equal(status.initialized, true);

    const ready = await provider.ready();
    assert.equal(ready[0]?.id, "bd-1");

    const created = await provider.create({
      planTaskId: "ATLR-001",
      title: "No shell; $(touch unsafe)",
      description: "Literal metacharacters: ; && >",
      acceptanceCriteria: ["Pass"],
      priority: 1,
      type: "task",
      labels: ["atelier-plan", "prototype"],
    });
    assert.equal(created.id, "bd-created");

    await provider.claim(created.id);
    await provider.addDependency(created.id, "bd-1");
    await provider.removeDependency(created.id, "bd-1");
    await provider.close(created.id, "validated");

    const commands = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const create = commands.find((args) => args[0] === "create");
    assert.ok(create);
    assert.equal(create[1], "No shell; $(touch unsafe)");
    assert.ok(create.includes("--labels"));
    assert.equal(create[create.indexOf("--labels") + 1], "atelier-plan,prototype");
    assert.equal(create.includes("--add-label"), false);
    assert.ok(commands.some((args) => args.slice(0, 4).join(" ") === "dep remove bd-created bd-1"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake Beads adapter satisfies the shared reconciliation conformance", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-beads-conformance-"));
  const executable = join(root, "fake-bd.mjs");
  const statePath = join(root, "state.json");
  const script = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const path = ${JSON.stringify(statePath)};
const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { next: 1, tasks: {} };
const save = () => writeFileSync(path, JSON.stringify(state));
const output = (value) => console.log(JSON.stringify(value));
const command = args[0];
if (command === "version") { console.log("bd conformance"); process.exit(0); }
if (command === "where") { output({ root: process.cwd() }); process.exit(0); }
if (command === "create") {
  const id = "bd-" + state.next++;
  const notes = args[args.indexOf("--notes") + 1] || "";
  state.tasks[id] = { id, title: args[1], description: args[args.indexOf("--description") + 1], notes, acceptance_criteria: args[args.indexOf("--acceptance") + 1], status: "open", priority: Number(args[args.indexOf("--priority") + 1]), issue_type: args[args.indexOf("--type") + 1], dependencies: [] };
  save(); output(state.tasks[id]); process.exit(0);
}
if (command === "show") { const task = state.tasks[args[1]]; if (!task) process.exit(1); output(task); process.exit(0); }
if (command === "list" || command === "ready") { output(Object.values(state.tasks)); process.exit(0); }
if (command === "dep") {
  const task = state.tasks[args[2]];
  const dependency = args[3];
  if (args[1] === "add" && !task.dependencies.includes(dependency)) task.dependencies.push(dependency);
  if (args[1] === "remove") task.dependencies = task.dependencies.filter((id) => id !== dependency);
  save(); output({ ok: true }); process.exit(0);
}
if (command === "close") { state.tasks[args[1]].status = "closed"; save(); output(state.tasks[args[1]]); process.exit(0); }
if (command === "update") { output(state.tasks[args[1]]); process.exit(0); }
console.error("unsupported", args); process.exit(2);
`;
  writeFileSync(executable, script, "utf8");
  chmodSync(executable, 0o755);
  try {
    await assertTaskProviderConformance(new BeadsCliTaskProvider({ cwd: root, executable }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
