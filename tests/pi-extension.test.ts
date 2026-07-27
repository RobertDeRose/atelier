import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import atelierExtension, { registerAtelierExtension } from "../apps/pi-extension/src/index.ts";
import { AtelierCore, InMemoryTaskProvider, MockCodeProvider, SqliteLedger } from "../packages/core/src/index.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createTemporaryRepository, VALID_PLAN } from "./fixtures.ts";

interface RegisteredTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute(
    toolCallId: string,
    params: any,
    signal: AbortSignal,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
}

interface RegisteredCommand {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

function fakeContext(
  cwd: string,
  confirms: { count: number },
  statuses: string[] = [],
  observations: { confirmationBodies?: string[]; notifications?: string[]; signal?: AbortSignal } = {},
): ExtensionCommandContext {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => true,
    waitForIdle: async () => {},
    ...(observations.signal === undefined ? {} : { signal: observations.signal }),
    ui: {
      confirm: async (_title: string, body: string) => {
        confirms.count += 1;
        observations.confirmationBodies?.push(body);
        return true;
      },
      select: async () => undefined,
      notify: (message: string) => { observations.notifications?.push(message); },
      setStatus: (_key: string, value: string | undefined) => { if (value !== undefined) statuses.push(value); },
      custom: async () => ({ exitCode: 0 }),
    },
  } as unknown as ExtensionCommandContext;
}

test("Pi extension enforces provider-first plan discovery without approving read-only commands", async () => {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, RegisteredTool>();
  let activeTools = ["read", "bash", "edit", "write"];
  const activeToolUpdates: string[][] = [];
  const sentMessages: string[] = [];
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void {
      events.set(name, handler);
    },
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(tool: RegisteredTool): void { tools.set(tool.name, tool); },
    getActiveTools(): string[] { return [...activeTools]; },
    setActiveTools(names: string[]): void {
      activeTools = [...names];
      activeToolUpdates.push([...names]);
    },
    sendUserMessage(message: string): void { sentMessages.push(message); },
  } as unknown as ExtensionAPI;

  atelierExtension(fakePi);

  for (const event of [
    "session_start",
    "session_shutdown",
    "tool_call",
    "tool_result",
    "before_agent_start",
    "session_before_compact",
    "agent_settled",
  ]) {
    assert.ok(events.has(event), `missing event ${event}`);
  }
  for (const command of ["status", "plan", "review", "approve", "execute", "cancel", "ready", "state", "code-status", "code-index", "code-search", "code-symbols", "changed", "validate", "evidence"]) {
    assert.ok(commands.has(command), `missing command ${command}`);
  }
  for (const tool of ["atlr_code_status", "atlr_code_search", "atlr_code_symbols"]) {
    assert.ok(tools.has(tool), `missing agent tool ${tool}`);
  }
  assert.match(tools.get("atlr_code_search")?.promptGuidelines?.join(" ") ?? "", /one focused semantic.*before broad raw scans/i);

  const root = createTemporaryRepository("atlr-pi-code-tool-");
  mkdirSync(join(root, ".atelier"), { recursive: true });
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "none",
    repositoryProvider: "git",
    codeProvider: "mock",
  }));
  const confirms = { count: 0 };
  const statuses: string[] = [];
  const context = fakeContext(root, confirms, statuses);
  await events.get("session_start")!({}, context);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(statuses.some((status) => /index (building|ready)/.test(status)), "Pi footer must expose background index state");
  await commands.get("plan")!.handler("investigate planning policy", context);
  assert.match(sentMessages.at(-1) ?? "", /Objective: investigate planning policy/);
  const readOnlyCompound = await events.get("tool_call")!({
    toolName: "bash",
    input: { command: "git log -3 --oneline && printf 'status\\n' && git status --short" },
  }, context);
  assert.equal(readOnlyCompound, undefined);
  assert.equal(confirms.count, 0, "read-only plan commands must not request approval");


  for (const command of [
    "find . -maxdepth 3 -type f | sort | head -250 && printf '\n--- package ---\n' && test -f package.json && node -e 'console.log(1)'",
    "rg -n -i 'demo|walkthrough|showcase|golden path' --glob '!node_modules/**' . | head -300",
    "find apps packages tests scripts docs -maxdepth 4 -type f | sort",
  ]) {
    const blocked = await events.get("tool_call")!({
      toolName: "bash",
      input: { command },
    }, context);
    assert.equal(blocked?.block, true, `expected provider-first block for: ${command}`);
    assert.match(blocked?.reason ?? "", /provider-first discovery/i);
  }
  assert.equal(confirms.count, 0, "provider routing must never request approval");

  const blockedRawScan = await events.get("tool_call")!({
    toolName: "bash",
    input: { command: "find examples -type f 2>/dev/null; rg -n 'policy' packages | head -20" },
  }, context);
  assert.equal(blockedRawScan?.block, true);
  assert.match(blockedRawScan?.reason ?? "", /provider-first discovery/i);
  assert.equal(confirms.count, 0, "routing denial must not become an approval prompt");

  const agentStart = await events.get("before_agent_start")!({ systemPrompt: "base" }, context);
  assert.match(agentStart?.systemPrompt ?? "", /start with one focused semantic atlr_code_search/i);
  assert.match(agentStart?.systemPrompt ?? "", /## Retrieval session/);
  assert.deepEqual(activeTools.slice(0, 3), ["atlr_code_search", "atlr_code_symbols", "atlr_code_status"]);
  assert.ok(activeToolUpdates.length >= 1, "Atelier must explicitly activate registered code tools");
  assert.ok(activeTools.includes("read"));
  assert.ok(activeTools.includes("bash"));

  const search = await tools.get("atlr_code_search")!.execute(
    "tool-1",
    { query: "planning policy" },
    new AbortController().signal,
    undefined,
    context,
  );
  assert.match(search.content[0]?.text ?? "", /No Atelier code matches/);

  const allowedFallback = await events.get("tool_call")!({
    toolName: "bash",
    input: { command: "find examples -type f 2>/dev/null; rg -n 'policy' packages | head -20" },
  }, context);
  assert.equal(allowedFallback, undefined);
  assert.equal(confirms.count, 0);

  await events.get("session_shutdown")!({}, context);
});

test("Pi code tools retain one retrieval session and enforce inventory-first decisions", async () => {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const tools = new Map<string, RegisteredTool>();
  let activeTools = ["read", "bash"];
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(): void {},
    registerTool(tool: RegisteredTool): void { tools.set(tool.name, tool); },
    getActiveTools(): string[] { return [...activeTools]; },
    setActiveTools(names: string[]): void { activeTools = [...names]; },
    sendUserMessage(): void {},
  } as unknown as ExtensionAPI;

  const root = createTemporaryRepository("atlr-pi-retrieval-session-");
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "none",
    repositoryProvider: "git",
    codeProvider: "mock",
    codeMaxProviderRequests: 4,
  }));
  class InstrumentedProvider extends MockCodeProvider {
    searchCalls = 0;
    symbolCalls = 0;
    revision = "index-1";
    degraded = false;
    override async status() {
      const status = await super.status();
      return {
        ...status,
        indexState: "ready" as const,
        indexRevision: this.revision,
        capabilities: [...new Set([...status.capabilities, "index.revision_aware" as const])],
        ...(this.degraded ? { degraded: true, warnings: ["instrumented degradation"] } : {}),
      };
    }
    override async search(query: Parameters<MockCodeProvider["search"]>[0]) {
      this.searchCalls += 1;
      return super.search(query);
    }
    override async symbols(query: Parameters<MockCodeProvider["symbols"]>[0]) {
      this.symbolCalls += 1;
      return super.symbols(query);
    }
  }
  const provider = new InstrumentedProvider([{
    repositoryId: "repo",
    repositoryName: "repo",
    root,
    path: "src/known.ts",
    symbol: "KnownSymbol",
    content: "export class KnownSymbol {}",
  }]);
  registerAtelierExtension(fakePi, {
    openCore: (repositoryRoot) => {
      const core = AtelierCore.open(repositoryRoot, { taskProvider: "none", codeProvider: provider });
      core.setMode("plan");
      return core;
    },
  });
  const context = fakeContext(root, { count: 0 });
  const execute = (name: string, params: Record<string, unknown>) => tools.get(name)!.execute(
    `tool-${name}`,
    params,
    new AbortController().signal,
    undefined,
    context,
  );

  let sessionId = "";
  try {
    await events.get("session_start")!({}, context);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const prematureSymbol = await execute("atlr_code_symbols", { query: "MissingSymbol" });
    assert.equal((prematureSymbol.details as any).retrieval.lastDecision.kind, "no_provider_call");
    assert.match(prematureSymbol.content[0]?.text ?? "", /semantic discovery first/i);
    assert.equal(provider.symbolCalls, 0);

    const first = await execute("atlr_code_search", { query: "Locate KnownSymbol and MissingSymbol", mode: "semantic" });
    sessionId = (first.details as any).retrieval.sessionId;
    assert.ok(sessionId);
    assert.equal(provider.searchCalls, 1);
    assert.deepEqual((first.details as any).retrieval.inventory.resolvedSymbols, ["KnownSymbol"]);
    assert.deepEqual((first.details as any).retrieval.inventory.unresolvedSymbols, ["MissingSymbol"]);
    assert.match(first.content[0]?.text ?? "", /Retrieval session:/);
    assert.match(first.content[0]?.text ?? "", /src\/known\.ts/i);
    assert.match(first.content[0]?.text ?? "", /built-in read/i);

    const repeated = await execute("atlr_code_search", { query: "  Locate KnownSymbol\n and MissingSymbol ", mode: "semantic" });
    assert.equal(provider.searchCalls, 1);
    assert.equal((repeated.details as any).retrieval.lastDecision.kind, "exact_reuse");
    assert.equal((repeated.details as any).retrieval.sessionId, sessionId);

    const resolvedSymbol = await execute("atlr_code_symbols", { query: "KnownSymbol" });
    assert.equal(provider.symbolCalls, 0);
    assert.equal((resolvedSymbol.details as any).retrieval.lastDecision.kind, "overlap_reuse");

    const unresolvedSymbol = await execute("atlr_code_symbols", { query: "MissingSymbol" });
    assert.equal(provider.symbolCalls, 1);
    assert.equal((unresolvedSymbol.details as any).retrieval.lastDecision.kind, "provider_call");

    const knownPath = await execute("atlr_code_search", { query: "src/known.ts" });
    assert.equal((knownPath.details as any).retrieval.lastDecision.kind, "direct_read");
    assert.match(knownPath.content[0]?.text ?? "", /built-in read/i);

    provider.revision = "index-2";
    const invalidated = await execute("atlr_code_search", { query: "Locate KnownSymbol and MissingSymbol", mode: "semantic" });
    assert.equal((invalidated.details as any).retrieval.lastDecision.kind, "invalidated");
    assert.ok((invalidated.details as any).retrieval.invalidations.length >= 1);

    provider.degraded = true;
    const degraded = await execute("atlr_code_search", { query: "Different degraded discovery" });
    assert.equal((degraded.details as any).status.degraded, true);
    const rawAfterDegradation = await events.get("tool_call")!({ toolName: "bash", input: { command: "rg -n KnownSymbol ." } }, context);
    assert.equal(rawAfterDegradation, undefined);

    const denied = await execute("atlr_code_search", { query: "One request beyond budget" });
    assert.equal((denied.details as any).retrieval.lastDecision.kind, "budget_denied");
    const rawAfterBudget = await events.get("tool_call")!({ toolName: "bash", input: { command: "rg -n KnownSymbol ." } }, context);
    assert.equal(rawAfterBudget?.block, true);
    assert.match(rawAfterBudget?.reason ?? "", /budget|inventory/i);

    const status = await execute("atlr_code_status", {});
    assert.equal((status.details as any).retrieval.sessionId, sessionId);
    assert.match(status.content[0]?.text ?? "", /Remaining provider requests:/);

    const compacted = await events.get("session_before_compact")!({
      preparation: { firstKeptEntryId: "entry", tokensBefore: 10_000 },
    }, context);
    assert.match(compacted.compaction.summary, new RegExp(sessionId));
  } finally {
    await events.get("session_shutdown")!({}, context);
    if (sessionId) {
      const ledger = new SqliteLedger(join(root, ".atelier", "atelier.db"));
      assert.equal(ledger.loadRetrievalCheckpoint(sessionId)?.status, "closed");
      ledger.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi /plan starts immediately without waiting on Pi idle state", async () => {
  const commands = new Map<string, RegisteredCommand>();
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const sentMessages: string[] = [];
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(): void {},
    getActiveTools(): string[] { return []; },
    setActiveTools(): void {},
    sendUserMessage(message: string): void { sentMessages.push(message); },
  } as unknown as ExtensionAPI;
  atelierExtension(fakePi);

  const root = createTemporaryRepository("atlr-pi-plan-command-");
  mkdirSync(join(root, ".atelier"), { recursive: true });
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "none",
    repositoryProvider: "git",
    codeProvider: "disabled",
  }));
  const context = {
    ...fakeContext(root, { count: 0 }),
    waitForIdle: () => new Promise<void>(() => {}),
  } as ExtensionCommandContext;

  try {
    await commands.get("plan")!.handler("continue building Atelier", context);
    assert.match(sentMessages.at(-1) ?? "", /Atelier PLAN MODE/);
    assert.match(sentMessages.at(-1) ?? "", /Objective: continue building Atelier/);
  } finally {
    await events.get("session_shutdown")!({}, context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi automatic ManualEdit review presents exact approval and supports cancellation", async () => {
  const commands = new Map<string, RegisteredCommand>();
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const sentMessages: string[] = [];
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(): void {},
    getActiveTools(): string[] { return []; },
    setActiveTools(): void {},
    sendUserMessage(message: string): void { sentMessages.push(message); },
  } as unknown as ExtensionAPI;
  registerAtelierExtension(fakePi);

  const root = createTemporaryRepository("atlr-pi-interactive-workflow-");
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "memory",
    repositoryProvider: "git",
    codeProvider: "disabled",
  }));
  writeFileSync(join(root, ".atelier", "PLAN.md"), VALID_PLAN, "utf8");
  const confirms = { count: 0 };
  const confirmationBodies: string[] = [];
  const notifications: string[] = [];
  const context = fakeContext(root, confirms, [], { confirmationBodies, notifications });

  try {
    await events.get("session_start")!({}, context);
    await commands.get("plan")!.handler("exercise the exact workflow", context);
    writeFileSync(
      join(root, ".atelier", "PLAN.md"),
      VALID_PLAN.replace("Create the guarded core.", "Create the exact guarded core."),
      "utf8",
    );
    await events.get("agent_settled")!({}, context);
    assert.ok(notifications.some((message) => /ManualEdit/i.test(message)));
    assert.equal(sentMessages.length, 1, "ManualEdit review must not ask the agent to restate user edits");

    await commands.get("approve")!.handler("", context);
    assert.equal(confirms.count, 1);
    assert.match(confirmationBodies[0] ?? "", /Plan hash:/i);
    assert.match(confirmationBodies[0] ?? "", /Provider:/i);
    assert.match(confirmationBodies[0] ?? "", /Operations:/i);
    assert.match(confirmationBodies[0] ?? "", /Proposed first task:/i);

    await commands.get("status")!.handler("", context);
    assert.ok(notifications.some((message) => /Next action:/i));
    await commands.get("cancel")!.handler("user stopped execution", context);
    assert.ok(notifications.some((message) => /cancelled execution/i));
  } finally {
    await events.get("session_shutdown")!({}, context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi /execute activates an explicitly requested later approved-plan task", async () => {
  const commands = new Map<string, RegisteredCommand>();
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const provider = new InMemoryTaskProvider();
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(): void {},
    getActiveTools(): string[] { return []; },
    setActiveTools(): void {},
    sendUserMessage(): void {},
  } as unknown as ExtensionAPI;

  const root = createTemporaryRepository("atlr-pi-execute-next-");
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "memory",
    repositoryProvider: "git",
    codeProvider: "disabled",
  }));
  writeFileSync(join(root, ".atelier", "PLAN.md"), VALID_PLAN, "utf8");
  const setup = AtelierCore.open(root, { taskProviderInstance: provider });
  setup.beginPlan("Execute later work");
  const review = setup.beginPlanReview();
  setup.completePlanReview(review.id, { exitCode: 0 });
  const prepared = await setup.execution.prepare();
  const first = await setup.execution.approveAndApply(prepared.approval.id, true);
  assert.ok(first.task);
  await provider.close(first.task.id, "completed");
  setup.execution.cancel(`Task ${first.task.id} was explicitly closed.`);
  setup.close();
  const requested = (await provider.ready()).find((task) => task.planTaskId === "ATLR-002");
  assert.ok(requested);

  registerAtelierExtension(fakePi, {
    openCore: (repositoryRoot) => AtelierCore.open(repositoryRoot, { taskProviderInstance: provider }),
  });
  const context = fakeContext(root, { count: 0 });
  try {
    await events.get("session_start")!({}, context);
    await commands.get("execute")!.handler(requested.id, context);
    assert.equal((await provider.get(requested.id))?.status, "in_progress");
  } finally {
    await events.get("session_shutdown")!({}, context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi focused validation passes the current abort signal and records interruption", async () => {
  const commands = new Map<string, RegisteredCommand>();
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(): void {},
    getActiveTools(): string[] { return []; },
    setActiveTools(): void {},
    sendUserMessage(): void {},
  } as unknown as ExtensionAPI;
  registerAtelierExtension(fakePi);

  const root = createTemporaryRepository("atlr-pi-validation-abort-");
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "memory",
    repositoryProvider: "git",
    codeProvider: "disabled",
  }));
  writeFileSync(join(root, ".atelier", "PLAN.md"), VALID_PLAN, "utf8");
  writeFileSync(join(root, ".atelier", "validation.json"), JSON.stringify({ validations: {
    focused: {
      command: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      category: "focused",
      focused: true,
      required: true,
      paths: ["src/**"],
    },
  } }), "utf8");
  const setup = AtelierCore.open(root, { taskProvider: "memory" });
  setup.beginPlan("Abort focused validation");
  const review = setup.beginPlanReview();
  setup.completePlanReview(review.id, { exitCode: 0 });
  const prepared = await setup.execution.prepare();
  const started = await setup.execution.approveAndApply(prepared.approval.id, true);
  assert.ok(started.task);
  setup.close();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "abort.ts"), "export const abort = true;\n", "utf8");

  const controller = new AbortController();
  const notifications: string[] = [];
  const context = fakeContext(root, { count: 0 }, [], { notifications, signal: controller.signal });
  try {
    await commands.get("validate")!.handler("plan", context);
    assert.ok(notifications.some((message) => /Focused selection .*focused.*required/is.test(message)));
    const pending = commands.get("validate")!.handler("focused", context);
    setTimeout(() => controller.abort(), 50);
    await pending;
    assert.ok(notifications.some((message) => /focused: interrupted/i.test(message)));
  } finally {
    await events.get("session_shutdown")!({}, context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi act mode requires execution-linked permissions and still prompts for destructive commands", async () => {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const sentMessages: string[] = [];
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(): void {},
    registerTool(): void {},
    getActiveTools(): string[] { return []; },
    setActiveTools(): void {},
    sendUserMessage(message: string): void { sentMessages.push(message); },
  } as unknown as ExtensionAPI;
  atelierExtension(fakePi);

  const root = createTemporaryRepository("atlr-pi-act-policy-");
  mkdirSync(join(root, ".atelier"), { recursive: true });
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "memory",
    repositoryProvider: "git",
    codeProvider: "disabled",
  }));
  writeFileSync(join(root, ".atelier", "PLAN.md"), VALID_PLAN, "utf8");
  const setup = AtelierCore.open(root, { taskProvider: "memory" });
  setup.beginPlan("Exercise act-mode policy");
  const review = setup.beginPlanReview();
  setup.completePlanReview(review.id, { exitCode: 0 });
  const prepared = await setup.execution.prepare();
  const started = await setup.execution.approveAndApply(prepared.approval.id, true);
  assert.ok(started.task);
  setup.grant({ permission: "file.write", scope: "task", taskId: started.task.id, paths: [join(root, "src")], reason: "edit source" });
  setup.grant({ permission: "validation.full_suite", scope: "task", taskId: started.task.id, reason: "run checks" });
  setup.grant({ permission: "command.long_running", scope: "task", taskId: started.task.id, reason: "run approved commands" });
  setup.grant({ permission: "repository.change.create", scope: "task", taskId: started.task.id, reason: "commit task" });
  setup.close();
  const confirms = { count: 0 };
  const statuses: string[] = [];
  const context = fakeContext(root, confirms, statuses);

  try {
    assert.equal(await events.get("tool_call")!({
      toolCallId: "edit-routine",
      toolName: "edit",
      input: { path: "src/index.ts" },
    }, context), undefined);
    const statusCountBeforeResult = statuses.length;
    await events.get("tool_result")!({
      toolCallId: "edit-routine",
      toolName: "edit",
      input: { path: "src/index.ts" },
      content: [{ type: "text", text: "updated" }],
      isError: false,
    }, context);
    assert.ok(statuses.length > statusCountBeforeResult, "tool results must refresh durable workflow status");
    assert.equal(await events.get("tool_call")!({
      toolCallId: "edit-failed",
      toolName: "edit",
      input: { path: "src/failed.ts" },
    }, context), undefined);
    await events.get("tool_result")!({
      toolCallId: "edit-failed",
      toolName: "edit",
      input: { path: "src/failed.ts" },
      content: [{ type: "text", text: "replacement did not match" }],
      isError: true,
    }, context);
    assert.equal(await events.get("tool_call")!({
      toolCallId: "bash-check",
      toolName: "bash",
      input: { command: "mise run check" },
    }, context), undefined);
    assert.equal(await events.get("tool_call")!({
      toolCallId: "bash-commit",
      toolName: "bash",
      input: { command: "git commit -am 'finish task'" },
    }, context), undefined);
    assert.equal(confirms.count, 0);

    assert.equal(await events.get("tool_call")!({
      toolCallId: "bash-destructive",
      toolName: "bash",
      input: { command: "rm -rf build" },
    }, context), undefined);
    assert.equal(confirms.count, 1);

    writeFileSync(join(root, "completion-guard.ts"), "export const pending = true;\n");
    await events.get("agent_settled")!({}, context);
    assert.match(sentMessages.at(-1) ?? "", /completion guard/i);
    assert.match(sentMessages.at(-1) ?? "", /Git commit/);
  } finally {
    await events.get("session_shutdown")!({}, context);
    const ledger = new SqliteLedger(join(root, ".atelier", "atelier.db"));
    assert.equal(ledger.getExecutionEvidence("edit-routine")?.status, "succeeded");
    assert.equal(ledger.getExecutionEvidence("edit-failed")?.status, "failed");
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
