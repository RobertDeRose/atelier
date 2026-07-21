import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BeadsCliTaskProvider, normalizeBeadsTask } from "../packages/core/src/tasks/beads-cli-provider.ts";

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
  });

  assert.equal(task.status, "in_progress");
  assert.equal(task.priority, 1);
  assert.equal(task.type, "feature");
  assert.deepEqual(task.dependencies, ["ATLR-root"]);
  assert.deepEqual(task.acceptanceCriteria, ["One", "Two"]);
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
