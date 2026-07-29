import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AtelierCore, SqliteLedger, parsePlanFile } from "../packages/core/src/index.ts";
import { registerAtelierExtension as registerPiExtension } from "../apps/pi-extension/src/index.ts";
import { createTemporaryRepository, testDatabasePath } from "./fixtures.ts";

interface RegisteredCommand {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

const OLD_PLAN = `# Acceptance Plan

<!-- atlr:plan version="1" -->

## ATLR-A — Existing implementation
<!-- atlr:task {"id":"ATLR-A","priority":2,"type":"task","execution":{"writePaths":["README.md"],"allowDependencyChanges":false,"validations":["focused"],"allowFullSuite":false,"allowLocalChange":true}} -->

### Goal

Keep the existing implementation.

### Depends on

- None

### Validation

- Run focused acceptance

### Completion criteria

- Existing behavior remains

## ATLR-B — First executable task
<!-- atlr:task {"id":"ATLR-B","priority":1,"type":"task","execution":{"writePaths":["src"],"allowDependencyChanges":false,"validations":["focused"],"allowFullSuite":false,"allowLocalChange":true}} -->

### Goal

Implement the accepted source change.

### Depends on

- ATLR-A

### Validation

- Run focused acceptance

### Completion criteria

- Focused validation passes

## ATLR-C — Retired task
<!-- atlr:task {"id":"ATLR-C","priority":3,"type":"task","execution":{"writePaths":["README.md"],"allowDependencyChanges":false,"validations":["focused"],"allowFullSuite":false,"allowLocalChange":true}} -->

### Goal

Retire obsolete work.

### Depends on

- None

### Validation

- Inspect reconciliation

### Completion criteria

- Task is retired explicitly
`;

const REVIEWED_PLAN = `# Acceptance Plan

<!-- atlr:plan version="1" -->

## ATLR-A — Updated implementation
<!-- atlr:task {"id":"ATLR-A","priority":2,"type":"task","execution":{"writePaths":["README.md"],"allowDependencyChanges":false,"validations":["focused"],"allowFullSuite":false,"allowLocalChange":true}} -->

### Goal

Update the existing implementation after its new prerequisite.

### Depends on

- ATLR-D

### Validation

- Run focused acceptance

### Completion criteria

- Existing behavior remains

## ATLR-B — First executable task
<!-- atlr:task {"id":"ATLR-B","priority":1,"type":"task","execution":{"writePaths":["src"],"allowDependencyChanges":false,"validations":["focused"],"allowFullSuite":false,"allowLocalChange":true}} -->

### Goal

Implement the accepted source change.

### Depends on

- None

### Validation

- Run focused acceptance

### Completion criteria

- Focused validation passes

## ATLR-D — New prerequisite
<!-- atlr:task {"id":"ATLR-D","priority":3,"type":"task","execution":{"writePaths":["README.md"],"allowDependencyChanges":false,"validations":["focused"],"allowFullSuite":false,"allowLocalChange":true}} -->

### Goal

Create a new provider task.

### Depends on

- None

### Validation

- Inspect reconciliation

### Completion criteria

- New task is mapped once
`;

function installPersistentFakeBeads(root: string): { executable: string; statePath: string; logPath: string } {
  const executable = join(root, ".atelier", "fake-bd.mjs");
  const statePath = join(root, ".atelier", "fake-bd-state.json");
  const logPath = join(root, ".atelier", "fake-bd-mutations.jsonl");
  writeFileSync(statePath, JSON.stringify({
    next: 4,
    tasks: {
      "bd-a": { id: "bd-a", title: "Existing implementation", description: "Keep the existing implementation.", design: "", notes: "Atelier plan task: ATLR-A", acceptance_criteria: "Existing behavior remains\nValidation: Run focused acceptance", status: "open", priority: 2, issue_type: "task", dependencies: [] },
      "bd-b": { id: "bd-b", title: "First executable task", description: "Implement the accepted source change.", design: "", notes: "Atelier plan task: ATLR-B", acceptance_criteria: "Focused validation passes\nValidation: Run focused acceptance", status: "open", priority: 1, issue_type: "task", dependencies: ["bd-a"] },
      "bd-c": { id: "bd-c", title: "Retired task", description: "Retire obsolete work.", design: "", notes: "Atelier plan task: ATLR-C", acceptance_criteria: "Task is retired explicitly\nValidation: Inspect reconciliation", status: "open", priority: 3, issue_type: "task", dependencies: [] },
    },
  }), "utf8");
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(logPath)};
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const output = (value) => console.log(JSON.stringify(value));
const value = (flag, fallback = "") => { const index = args.indexOf(flag); return index === -1 ? fallback : args[index + 1]; };
const mutate = () => appendFileSync(logPath, JSON.stringify(args) + "\\n");
const command = args[0];
if (command === "version") { console.log("bd acceptance-1"); process.exit(0); }
if (command === "where") { output({ root: process.cwd() }); process.exit(0); }
if (command === "list") { output(Object.values(state.tasks)); process.exit(0); }
if (command === "show") { const task = state.tasks[args[1]]; if (!task) process.exit(1); output(task); process.exit(0); }
if (command === "ready") { output(Object.values(state.tasks).filter((task) => task.status === "open" && task.dependencies.every((id) => state.tasks[id]?.status === "closed"))); process.exit(0); }
if (command === "create") {
  mutate(); const id = "bd-" + state.next++;
  state.tasks[id] = { id, title: args[1], description: value("--description"), design: value("--design"), notes: value("--notes"), acceptance_criteria: value("--acceptance"), status: "open", priority: Number(value("--priority", "2")), issue_type: value("--type", "task"), dependencies: [], labels: value("--labels").split(",").filter(Boolean) };
  save(); output(state.tasks[id]); process.exit(0);
}
if (command === "update") {
  mutate(); const task = state.tasks[args[1]]; if (!task) process.exit(1);
  if (args.includes("--claim")) task.status = "in_progress";
  for (const [flag, field] of [["--title", "title"], ["--description", "description"], ["--design", "design"], ["--notes", "notes"], ["--acceptance", "acceptance_criteria"], ["--status", "status"], ["--type", "issue_type"]]) { const index = args.indexOf(flag); if (index !== -1) task[field] = args[index + 1]; }
  const priority = args.indexOf("--priority"); if (priority !== -1) task.priority = Number(args[priority + 1]);
  save(); output(task); process.exit(0);
}
if (command === "dep") {
  mutate(); const task = state.tasks[args[2]]; const dependency = args[3];
  if (args[1] === "add" && !task.dependencies.includes(dependency)) task.dependencies.push(dependency);
  if (args[1] === "remove") task.dependencies = task.dependencies.filter((id) => id !== dependency);
  save(); output({ ok: true }); process.exit(0);
}
if (command === "close") { mutate(); state.tasks[args[1]].status = "closed"; save(); output(state.tasks[args[1]]); process.exit(0); }
console.error("unsupported", args); process.exit(2);
`, "utf8");
  chmodSync(executable, 0o755);
  return { executable, statePath, logPath };
}

function mutationLog(path: string): string[][] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

test("Given a reviewed plan, the supported local workflow remains exact, durable, and resumable", async () => {
  const root = createTemporaryRepository("atlr-acceptance-workflow-");
  const fake = installPersistentFakeBeads(root);
  const editor = join(root, ".atelier", "acceptance-editor.mjs");
  writeFileSync(editor, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], ${JSON.stringify(REVIEWED_PLAN)}, "utf8");\n`, "utf8");
  chmodSync(editor, 0o755);
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "beads",
    beadsCommand: fake.executable,
    repositoryProvider: "git",
    codeProvider: "disabled",
    editor,
  }), "utf8");
  writeFileSync(join(root, ".atelier", "PLAN.md"), OLD_PLAN, "utf8");
  writeFileSync(join(root, ".atelier", "validation.json"), JSON.stringify({ validations: {
    focused: {
      command: [process.execPath, "-e", "process.exit(0)"],
      category: "focused",
      focused: true,
      required: true,
      paths: ["src/**"],
    },
  } }), "utf8");

  const oldPlan = parsePlanFile(join(root, ".atelier", "PLAN.md"));
  const seed = AtelierCore.open(root);
  seed.ledger.setTaskMapping("ATLR-A", "beads", "bd-a", oldPlan.hash);
  seed.ledger.setTaskMapping("ATLR-B", "beads", "bd-b", oldPlan.hash);
  seed.ledger.setTaskMapping("ATLR-C", "beads", "bd-c", oldPlan.hash);
  await seed.close();

  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const commands = new Map<string, RegisteredCommand>();
  const notifications: string[] = [];
  const sentMessages: string[] = [];
  const confirmations = [false, true];
  const confirmationBodies: string[] = [];
  let confirmationCount = 0;
  let stopped = 0;
  let started = 0;
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(): void {},
    getActiveTools(): string[] { return ["read", "bash", "edit", "write"]; },
    setActiveTools(): void {},
    sendUserMessage(message: string): void { sentMessages.push(message); },
  } as unknown as ExtensionAPI;
  registerPiExtension(fakePi);
  const context = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => true,
    waitForIdle: async () => {},
    ui: {
      confirm: async (_title: string, body: string) => {
        confirmationCount += 1;
        confirmationBodies.push(body);
        return confirmations.shift() ?? true;
      },
      select: async () => undefined,
      notify: (message: string) => { notifications.push(message); },
      setStatus: () => {},
      custom: async (factory: any) => {
        let result: unknown;
        factory({
          stop: () => { stopped += 1; },
          start: () => { started += 1; },
          requestRender: () => {},
        }, {}, {}, (value: unknown) => { result = value; });
        return result;
      },
    },
  } as unknown as ExtensionCommandContext;

  try {
    await events.get("session_start")!({}, context);
    await commands.get("plan")!.handler("prove local acceptance", context);
    assert.match(sentMessages[0] ?? "", /Objective: prove local acceptance/);
    const planDraftRequest = await events.get("tool_call")!({
      toolCallId: "acceptance-plan-write",
      toolName: "write",
      input: { path: join(root, ".atelier", "PLAN.md") },
    }, context);
    assert.equal(planDraftRequest, undefined, "plan drafting must not require an act-mode execution grant");
    let ledger = new SqliteLedger(testDatabasePath(root));
    assert.equal(ledger.getExecutionEvidence("acceptance-plan-write"), undefined, "ManualEdit owns plan mutation evidence");
    ledger.close();
    await events.get("agent_settled")!({}, context);
    assert.equal(stopped, 1);
    assert.equal(started, 1);
    const reviewNotice = notifications.find((message) => /ManualEdit/.test(message)) ?? "";
    assert.match(reviewNotice, /added ATLR-D/i);
    assert.match(reviewNotice, /removed ATLR-C/i);
    for (const operation of ["create", "update", "link", "unlink", "retire"]) assert.match(reviewNotice, new RegExp(operation));

    assert.equal(mutationLog(fake.logPath).length, 0, "preview must not mutate provider state");
    await commands.get("approve")!.handler("", context);
    assert.equal(mutationLog(fake.logPath).length, 0, "rejected exact approval must not mutate provider state");
    ledger = new SqliteLedger(testDatabasePath(root));
    assert.equal(ledger.getActiveExecutionGrant(), undefined);
    assert.equal(ledger.getState("workflowMode"), "plan");
    ledger.close();

    const messagesBeforeApproval = sentMessages.length;
    await commands.get("approve")!.handler("", context);
    const approvalSummary = notifications.find((message) => /Capabilities for ATLR-B:/.test(message)) ?? "";
    assert.match(approvalSummary, /Writes: src/);
    assert.match(approvalSummary, /Dependencies: not permitted/);
    assert.match(approvalSummary, /Focused validations: focused/);
    assert.match(approvalSummary, /Full suite: not permitted/);
    assert.match(approvalSummary, /Generic shell, publication, external effects, and out-of-scope paths: not permitted/);
    assert.equal(sentMessages.length, messagesBeforeApproval, "approval must not start an agent turn");
    assert.match(notifications.at(-1) ?? "", /Atelier is idle; send an explicit implementation instruction/i);
    const operations = mutationLog(fake.logPath);
    assert.equal(operations.filter((args) => args[0] === "create").length, 1);
    assert.ok(operations.some((args) => args[0] === "update" && !args.includes("--claim")));
    assert.ok(operations.some((args) => args.slice(0, 2).join(" ") === "dep add"));
    assert.ok(operations.some((args) => args.slice(0, 2).join(" ") === "dep remove"));
    assert.ok(operations.some((args) => args[0] === "close" && args[1] === "bd-c"));
    assert.ok(operations.some((args) => args[0] === "update" && args.includes("--claim")));
    const providerState = JSON.parse(readFileSync(fake.statePath, "utf8")) as { tasks: Record<string, { notes?: string }> };
    assert.equal(Object.values(providerState.tasks).filter((task) => task.notes?.includes("Atelier plan task: ATLR-D")).length, 1);

    ledger = new SqliteLedger(testDatabasePath(root));
    const grant = ledger.getActiveExecutionGrant();
    assert.ok(grant);
    assert.equal(ledger.getState("workflowMode"), "act");
    const capabilities = ledger.listGrants();
    assert.equal(capabilities.length, 4, "exact approval must install only the active task capability bundle");
    assert.ok(capabilities.every((item) => item.scope === "task" && item.executionGrantId === grant.id));
    assert.equal(ledger.getTaskMapping("ATLR-D")?.providerTaskId === undefined, false);
    ledger.close();

    mkdirSync(join(root, "src"), { recursive: true });
    assert.equal(confirmationCount, 2, "only the reject and exact approval decisions have occurred");
    const firstRequest = await events.get("tool_call")!({
      toolCallId: "acceptance-write-1",
      toolName: "write",
      input: { path: "src/accepted.ts" },
    }, context);
    assert.equal(firstRequest, undefined);
    assert.equal(confirmationCount, 2, "typed task writes use the exact approved capability bundle");
    ledger = new SqliteLedger(testDatabasePath(root));
    const fileCapability = ledger.listGrants()
      .find((item) => item.permission === "file.write" && item.scope === "task");
    assert.equal(fileCapability?.executionGrantId, grant.id);
    ledger.close();
    writeFileSync(join(root, "src", "accepted.ts"), "export const accepted = 1;\n", "utf8");
    await events.get("tool_result")!({
      toolCallId: "acceptance-write-1",
      toolName: "write",
      input: { path: "src/accepted.ts" },
      content: [{ type: "text", text: "written" }],
      isError: false,
    }, context);

    await commands.get("validate")!.handler("plan", context);
    await commands.get("validate")!.handler("focused", context);
    await commands.get("evidence")!.handler("", context);
    assert.match(notifications.at(-1) ?? "", /focused: passed \(current\)/i);

    const secondRequest = await events.get("tool_call")!({
      toolCallId: "acceptance-write-2",
      toolName: "write",
      input: { path: "src/accepted.ts" },
    }, context);
    assert.equal(secondRequest, undefined);
    assert.equal(confirmationCount, 2, "the task capability authorizes later typed writes without another prompt");
    writeFileSync(join(root, "src", "accepted.ts"), "export const accepted = 2;\n", "utf8");
    await events.get("tool_result")!({
      toolCallId: "acceptance-write-2",
      toolName: "write",
      input: { path: "src/accepted.ts" },
      content: [{ type: "text", text: "written again" }],
      isError: false,
    }, context);
    await commands.get("evidence")!.handler("", context);
    assert.match(notifications.at(-1) ?? "", /focused: passed \(stale\)/i);
    await commands.get("validate")!.handler("focused", context);
    await commands.get("evidence")!.handler("", context);
    assert.match(notifications.at(-1) ?? "", /focused: passed \(current\)/i);

    await events.get("session_shutdown")!({}, context);
    const createCountBeforeResume = mutationLog(fake.logPath).filter((args) => args[0] === "create").length;
    await events.get("session_start")!({ reason: "resume" }, context);
    await commands.get("state")!.handler("", context);
    const resumedState = notifications.at(-1) ?? "";
    assert.match(resumedState, /Mode: act/);
    assert.match(resumedState, /Execution grant: .*active/);
    assert.equal((resumedState.match(/write\/write\.file: succeeded/g) ?? []).length, 2);
    assert.match(resumedState, /focused: passed/);
    assert.equal(mutationLog(fake.logPath).filter((args) => args[0] === "create").length, createCountBeforeResume);

    await commands.get("cancel")!.handler("acceptance cancellation", context);
    await events.get("session_shutdown")!({}, context);
    const reopened = AtelierCore.open(root);
    assert.equal(reopened.ledger.listExecutionEvidence({ taskId: grant.taskId }).filter((item) => item.action === "write.file").length, 2);
    const finalState = await reopened.buildWorkingState();
    assert.equal(reopened.mode(), "plan");
    assert.equal(reopened.ledger.getActiveExecutionGrant(), undefined);
    assert.equal(finalState.executionGrant?.status, "revoked");
    assert.equal(finalState.executionEvidence.filter((item) => item.action === "write.file").length, 2);
    assert.ok(finalState.focusedValidationSelections.length > 0, "cancelled work retains its focused selection evidence");
    assert.equal((await reopened.taskProvider.get(grant.taskId))?.status, "in_progress");
    assert.equal(reopened.validation.list({ currentSnapshot: reopened.repository.snapshot() })[0]?.status, "passed");
    assert.equal(reopened.validation.list({ currentSnapshot: reopened.repository.snapshot() })[0]?.stale, false);
    await reopened.close();
  } finally {
    try { await events.get("session_shutdown")?.({}, context); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  }
});
