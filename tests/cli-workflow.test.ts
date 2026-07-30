import assert from "node:assert/strict";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createTemporaryRepository, VALID_PLAN } from "./fixtures.ts";

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [
    "--no-warnings",
    "--experimental-strip-types",
    join(process.cwd(), "apps", "cli", "src", "main.ts"),
    "--root", root,
    ...args,
  ], { encoding: "utf8", shell: false });
}

function installFakeBeads(root: string): string {
  const executable = join(root, ".atelier", "fake-bd.mjs");
  const statePath = join(root, ".atelier", "fake-bd-state.json");
  writeFileSync(executable, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const path = ${JSON.stringify(statePath)};
const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { next: 1, tasks: {} };
const save = () => writeFileSync(path, JSON.stringify(state));
const output = (value) => console.log(JSON.stringify(value));
const command = args[0];
if (command === "version") { console.log("bd workflow-test"); process.exit(0); }
if (command === "where") { output({ root: process.cwd() }); process.exit(0); }
if (command === "create") {
  const id = "bd-" + state.next++;
  const value = (flag, fallback = "") => { const index = args.indexOf(flag); return index === -1 ? fallback : args[index + 1]; };
  state.tasks[id] = { id, title: args[1], description: value("--description"), design: value("--design"), notes: value("--notes"), acceptance_criteria: value("--acceptance"), status: "open", priority: Number(value("--priority", "2")), issue_type: value("--type", "task"), dependencies: [], labels: (value("--labels") || "").split(",").filter(Boolean) };
  save(); output(state.tasks[id]); process.exit(0);
}
if (command === "show") { const task = state.tasks[args[1]]; if (!task) process.exit(1); output(task); process.exit(0); }
if (command === "list") { output(Object.values(state.tasks)); process.exit(0); }
if (command === "ready") {
  output(Object.values(state.tasks).filter((task) => task.status === "open" && task.dependencies.every((id) => state.tasks[id]?.status === "closed")));
  process.exit(0);
}
if (command === "dep") {
  const task = state.tasks[args[2]];
  const dependency = args[3];
  if (args[1] === "add" && !task.dependencies.includes(dependency)) task.dependencies.push(dependency);
  if (args[1] === "remove") task.dependencies = task.dependencies.filter((id) => id !== dependency);
  save(); output({ ok: true }); process.exit(0);
}
if (command === "update") {
  const task = state.tasks[args[1]];
  if (args.includes("--claim")) task.status = "in_progress";
  for (const [flag, field] of [["--title", "title"], ["--description", "description"], ["--design", "design"], ["--notes", "notes"], ["--acceptance", "acceptance_criteria"], ["--status", "status"]]) {
    const index = args.indexOf(flag); if (index !== -1) task[field] = args[index + 1];
  }
  save(); output(task); process.exit(0);
}
if (command === "close") { state.tasks[args[1]].status = "closed"; save(); output(state.tasks[args[1]]); process.exit(0); }
console.error("unsupported", args); process.exit(2);
`, "utf8");
  chmodSync(executable, 0o755);
  return executable;
}

test("CLI review, exact approval, cancellation, and JSON workflow remain coordinated", () => {
  const root = createTemporaryRepository("atlr-cli-workflow-");
  const beads = installFakeBeads(root);
  const editor = join(root, "editor.mjs");
  writeFileSync(editor, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
  chmodSync(editor, 0o755);
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "beads",
    beadsCommand: beads,
    repositoryProvider: "git",
    codeProvider: "disabled",
    editor,
  }), "utf8");
  writeFileSync(join(root, ".atelier", "PLAN.md"), VALID_PLAN, "utf8");

  try {
    assert.equal(run(root, ["plan", "coordinate CLI workflow"]).status, 0);
    const review = run(root, ["review", "--json"]);
    assert.equal(review.status, 0, review.stderr);
    const reviewed = JSON.parse(review.stdout) as any;
    assert.equal(reviewed.manualEdit.accepted, true);
    assert.ok(Array.isArray(reviewed.manualEdit.structuralDiff.added));
    assert.ok(Array.isArray(reviewed.diagnostics));
    assert.ok(Array.isArray(reviewed.reconciliation.operations));

    const prepare = run(root, ["plan", "prepare", "--json"]);
    assert.equal(prepare.status, 0, prepare.stderr);
    const prepared = JSON.parse(prepare.stdout) as any;
    assert.equal(prepared.approval.status, "prepared");
    assert.equal(prepared.approval.reconciliationDigest, prepared.reconciliation.digest);

    const noAffirmation = run(root, [
      "approve", "--approval", prepared.approval.id,
      "--digest", prepared.approval.reconciliationDigest,
    ]);
    assert.equal(noAffirmation.status, 1);
    assert.match(noAffirmation.stderr, /--yes/i);

    const wrongDigest = run(root, [
      "approve", "--approval", prepared.approval.id,
      "--digest", "wrong", "--yes",
    ]);
    assert.equal(wrongDigest.status, 1);
    assert.match(wrongDigest.stderr, /digest/i);

    writeFileSync(join(root, ".atelier", "PLAN.md"), VALID_PLAN.replace("guarded core", "drifted core"), "utf8");
    const drifted = run(root, [
      "approve", "--approval", prepared.approval.id,
      "--digest", prepared.approval.reconciliationDigest,
      "--yes",
    ]);
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /plan changed after preparation/i);
    writeFileSync(join(root, ".atelier", "PLAN.md"), VALID_PLAN, "utf8");

    const approved = run(root, [
      "approve", "--approval", prepared.approval.id,
      "--digest", prepared.approval.reconciliationDigest,
      "--yes", "--json",
    ]);
    assert.equal(approved.status, 0, approved.stderr);
    const transition = JSON.parse(approved.stdout) as any;
    assert.equal(transition.approval.status, "approved");
    assert.equal(transition.task.status, "in_progress");
    assert.equal(transition.executionGrant.taskId, transition.task.id);

    const status = run(root, ["status", "--json"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(typeof JSON.parse(status.stdout).workflow.nextAction, "string");

    const cancelled = run(root, ["cancel", "--reason", "CLI operator stopped", "--json"]);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).executionGrant.status, "revoked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
