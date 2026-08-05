import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import atelierExtension, { registerAtelierExtension } from "../apps/pi-extension/src/index.ts";
import { executionGrantText, planStatusText, vcsStatusText } from "../apps/pi-extension/src/status-presentation.ts";
import { recoveryActionDialog } from "../apps/pi-extension/src/approval-dialog.ts";
import { approveStandaloneTask, parseStandaloneTaskCommand } from "../apps/pi-extension/src/standalone-task-command.ts";
import {
  AtelierCore,
  InMemoryTaskProvider,
  MockCodeProvider,
  SqliteLedger,
} from "../packages/core/src/index.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createTemporaryRepository, testDatabasePath, VALID_PLAN } from "./fixtures.ts";

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

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function fakeContext(
  cwd: string,
  confirms: { count: number },
  statuses: string[] = [],
  observations: {
    confirmationBodies?: string[];
    notifications?: string[];
    widgets?: string[][];
    widgetEvents?: Array<{ key: string; content: unknown; placement?: "aboveEditor" | "belowEditor" }>;
    footers?: string[];
    workingMessages?: Array<string | undefined>;
    statusEvents?: Array<{ key: string; value: string | undefined }>;
    onFooter?: (footer: string) => void;
    signal?: AbortSignal;
    isIdle?: () => boolean;
    abort?: () => void;
    waitForIdle?: () => Promise<void>;
    confirmResult?: boolean;
    confirmResults?: boolean[];
    renderCustom?: boolean;
    modelId?: string;
    thinkingLevel?: string;
    sessionKey?: object;
  } = {},
): ExtensionCommandContext {
  const statusValues = new Map<string, string>();
  return {
    sessionManager: observations.sessionKey ?? {},
    cwd,
    mode: "tui",
    hasUI: true,
    isIdle: observations.isIdle ?? (() => true),
    isProjectTrusted: () => true,
    waitForIdle: observations.waitForIdle ?? (async () => {}),
    ...(observations.abort === undefined ? {} : { abort: observations.abort }),
    ...(observations.signal === undefined ? {} : { signal: observations.signal }),
    model: { id: observations.modelId ?? "test-model" },
    thinkingLevel: observations.thinkingLevel,
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    ui: {
      confirm: async (_title: string, body: string) => {
        confirms.count += 1;
        observations.confirmationBodies?.push(body);
        return observations.confirmResults?.shift() ?? observations.confirmResult ?? true;
      },
      select: async () => undefined,
      notify: (message: string) => { observations.notifications?.push(message); },
      setStatus: (key: string, value: string | undefined) => {
        observations.statusEvents?.push({ key, value });
        if (value === undefined) statusValues.delete(key);
        else {
          statusValues.set(key, value);
          statuses.push(value);
        }
      },
      setWorkingMessage: (message?: string) => { observations.workingMessages?.push(message); },
      setWorkingVisible: (): void => {},
      setWidget: (
        key: string,
        content:
          | string[]
          | ((tui: { requestRender(): void }, theme: unknown) => {
              render(width: number): string[];
              dispose?(): void;
            })
          | undefined,
        options?: { placement?: "aboveEditor" | "belowEditor" },
      ) => {
        observations.widgetEvents?.push({
          key,
          content,
          ...(options?.placement === undefined ? {} : { placement: options.placement }),
        });
        if (Array.isArray(content)) observations.widgets?.push(content);
        else if (typeof content === "function") {
          const component = content({ requestRender(): void {} }, {});
          observations.widgets?.push(component.render(240));
          component.dispose?.();
        }
      },
      setFooter: (factory: any) => {
        if (factory === undefined) return;
        const component = factory({}, {}, {
          getExtensionStatuses: () => statusValues,
        });
        const footer = component.render(240).join("\n");
        observations.footers?.push(footer);
        observations.onFooter?.(footer);
      },
      custom: async (factory: any) => {
        if (!observations.renderCustom) return { exitCode: 0 };
        return await new Promise((resolve) => {
          const component = factory(
            { stop(): void {}, start(): void {}, requestRender(): void {} },
            {},
            {},
            resolve,
          );
          observations.widgets?.push(component.render(240));
          component.handleInput(observations.confirmResult === false ? "escape" : "enter");
        });
      },
    },
  } as unknown as ExtensionCommandContext;
}

function registerTrustCommandHarness(): {
  events: Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>;
  commands: Map<string, RegisteredCommand>;
} {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const commands = new Map<string, RegisteredCommand>();
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void {
      events.set(name, handler);
    },
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(): void {},
    getActiveTools(): string[] { return ["read", "bash", "edit", "write"]; },
    setActiveTools(): void {},
    sendUserMessage(): void {},
  } as unknown as ExtensionAPI;

  atelierExtension(fakePi);
  return { events, commands };
}


test("standalone Pi task commands default to repository-wide source scope", () => {
  assert.deepEqual(parseStandaloneTaskCommand("task-1"), {
    taskId: "task-1",
    writePaths: [],
  });
  assert.deepEqual(parseStandaloneTaskCommand("--task task-1"), {
    taskId: "task-1",
    writePaths: [],
  });
  assert.deepEqual(parseStandaloneTaskCommand("--standalone task-1"), {
    taskId: "task-1",
    writePaths: [],
  });
  assert.throws(
    () => parseStandaloneTaskCommand("task-1 --task task-2"),
    /accepts only one task id/i,
  );
});

test("explicit standalone approval activates without a second confirmation", async () => {
  const root = createTemporaryRepository("atlr-standalone-approval-ui-");
  const confirms = { count: 0 };
  const notifications: string[] = [];
  const context = fakeContext(root, confirms, [], { notifications });
  const task = { id: "task-1", title: "Test standalone task" };
  let received: { confirmed: boolean } | undefined;
  const core = {
    taskProvider: {
      status: async () => ({ available: true, initialized: true }),
      get: async () => task,
    },
    execution: {
      startStandaloneTask: async (_options: unknown, confirmed: boolean) => {
        received = { confirmed };
        return { task, executionGrant: { id: "grant-1" } };
      },
    },
  } as unknown as AtelierCore;
  try {
    await approveStandaloneTask(context, core, { taskId: task.id, writePaths: [] }, async () => {});
    assert.equal(confirms.count, 0);
    assert.deepEqual(received, { confirmed: true });
    assert.ok(notifications.some((message) => /Activated standalone task task-1/.test(message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi startup makes a recovered active task actionable without re-approval", async () => {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const sentMessages: string[] = [];
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(): void {},
    registerTool(): void {},
    registerEntryRenderer(): void {},
    getActiveTools(): string[] { return ["read", "bash", "edit", "write"]; },
    setActiveTools(): void {},
    sendUserMessage(message: string): void { sentMessages.push(message); },
  } as unknown as ExtensionAPI;
  const root = createTemporaryRepository("atlr-pi-recovered-task-");
  const provider = new InMemoryTaskProvider([{
    id: "task-1",
    title: "Recovered task",
    description: "Continue the bounded change.",
    acceptanceCriteria: ["The change is complete."],
    status: "open",
    priority: 1,
    type: "task",
    dependencies: [],
    labels: [],
  }]);
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "memory",
    repositoryProvider: "git",
    codeProvider: "disabled",
  }));
  const core = AtelierCore.open(root, { taskProviderInstance: provider });
  const transition = await core.execution.startStandaloneTask({ taskId: "task-1" }, true);
  assert.ok(transition);
  registerAtelierExtension(fakePi, { openCore: () => core });
  const notifications: string[] = [];
  const widgets: string[][] = [];
  const context = fakeContext(root, { count: 0 }, [], {
    notifications,
    widgets,
    renderCustom: true,
  });
  try {
    await events.get("session_start")!({ reason: "startup" }, context);
    assert.match(widgets.flat().join("\n"), /Recovered active task: task-1/);
    assert.deepEqual(sentMessages, ["Continue the recovered active task task-1 from Atelier Working State."]);
    assert.equal(core.ledger.getActiveExecutionGrant()?.id, transition.executionGrant.id);
  } finally {
    await events.get("session_shutdown")!({ reason: "quit" }, context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi recovery prompt exposes explicit continue, pause, and cancel actions", () => {
  const confirms = { count: 0 };
  const context = fakeContext("/tmp", confirms, [], { renderCustom: true });
  return recoveryActionDialog(context, "task-1").then((action) => assert.equal(action, "continue"));
});

test("Pi status presentation distinguishes missing plans, execution grants, and VCS identity", () => {
  const missing = {
    planStatus: "missing",
    activeExecutionGrant: undefined,
    snapshot: { vcs: "jj", changeId: "utymmrozoqkx", headCommit: "deadbeef" },
  } as any;
  assert.equal(planStatusText(missing), "missing");
  assert.equal(executionGrantText(missing), "none");
  assert.equal(vcsStatusText(missing), "jj utymmroz");

  const active = {
    planStatus: "approved",
    activeExecutionGrant: { id: "execution_123", status: "active", taskId: "repo-1" },
    snapshot: { vcs: "git", headCommit: "1234567890abcdef" },
  } as any;
  assert.equal(planStatusText(active), "approved");
  assert.equal(executionGrantText(active), "execution_123 (active) for repo-1");
  assert.equal(vcsStatusText(active), "git 12345678");
});

test("Pi /trust remains independent and Atelier establishes the startup workspace without a trust command", async () => {
  const { events, commands } = registerTrustCommandHarness();
  assert.equal(commands.has("trust"), false, "Pi owns /trust");
  assert.equal(commands.has("atelier-trust"), false, "Atelier no longer exposes a second trust UI");
  const root = createTemporaryRepository("atlr-pi-workspace-");
  const context = fakeContext(root, { count: 0 });
  try {
    await events.get("session_start")!({}, context);
    const core = AtelierCore.open(root, { taskProvider: "none" });
    assert.equal(core.config.workspaceRoot, realpathSync.native(root));
    assert.equal(core.config.workspaceSource, "startup_cwd");
    await core.close();
  } finally {
    await events.get("session_shutdown")!({}, context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi extension makes provider-first discovery explicit while confining typed reads and safe shell reads", async () => {
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
    "session_compact",
    "model_select",
    "thinking_level_select",
    "tool_call",
    "tool_result",
    "before_agent_start",
    "session_before_compact",
    "agent_settled",
  ]) {
    assert.ok(events.has(event), `missing event ${event}`);
  }
  for (const command of ["status", "plan", "review", "approve", "execute", "cancel", "ready", "state", "code-status", "code-index", "code-search", "code-symbols", "changed", "validate", "evidence", "review-diff", "commit", "close"]) {
    assert.ok(commands.has(command), `missing command ${command}`);
  }
  assert.equal(commands.has("trust"), false, "Pi reserves /trust; Atelier must not register a conflicting command");
  for (const tool of ["atlr_code_status", "atlr_code_search", "atlr_code_symbols", "atlr_validate"]) {
    assert.ok(tools.has(tool), `missing agent tool ${tool}`);
  }
  assert.match(tools.get("atlr_code_search")?.promptGuidelines?.join(" ") ?? "", /one focused semantic.*before broad raw scans/i);

  const root = createTemporaryRepository("atlr-pi-code-tool-");
  mkdirSync(join(root, ".atelier"), { recursive: true });
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "none",
    repositoryProvider: "git",
    codeProvider: "mock",
    sandboxBackend: "none",
  }));
  for (const args of [
    ["add", ".atelier/config.json"],
    ["commit", "--quiet", "--no-gpg-sign", "-m", "test: configure footer refresh"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const confirms = { count: 0 };
  const statuses: string[] = [];
  const notifications: string[] = [];
  const footers: string[] = [];
  const context = fakeContext(root, confirms, statuses, { notifications, footers });
  await events.get("session_start")!({}, context);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(statuses.some((status) => /index (building|ready)/.test(status)), "Pi footer must expose background index state");
  assert.ok(footers.some((footer) => /git: .*\b(?:clean|dirty|conflicted|unknown)\b/.test(footer)), "custom footer must expose the selected Git provider identity and state");
  assert.ok(footers.every((footer) => !/detached/i.test(footer)), "custom footer must not repeat Pi's Git-only detached label");
  await commands.get("plan")!.handler("investigate planning policy", context);
  assert.match(sentMessages.at(-1) ?? "", /Objective: investigate planning policy/);
  assert.match(sentMessages.at(-1) ?? "", /reuse current scoped inventory with atlr_code_status or call atlr_code_search once/i);

  const planWrite = await events.get("tool_call")!({
    toolCallId: "plan-write",
    toolName: "write",
    input: { path: join(root, ".atelier", "PLAN.md") },
  }, context);
  assert.equal(planWrite, undefined, "the designated plan write must not require an act-mode execution grant");
  const ledger = new SqliteLedger(testDatabasePath(root));
  assert.equal(ledger.getExecutionEvidence("plan-write"), undefined, "ManualEdit, not execution evidence, records plan drafting");
  ledger.close();
  assert.equal(confirms.count, 0, "the designated plan write is permitted directly in plan mode");

  const readOnlyCompound = await events.get("tool_call")!({
    toolName: "bash",
    input: { command: "git log -3 --oneline && printf 'status\\n' && git status --short" },
  }, context);
  assert.equal(readOnlyCompound, undefined);
  assert.equal(confirms.count, 0, "a clearly read-only shell command does not need unsandboxed approval");
  const shellLedger = new SqliteLedger(testDatabasePath(root));
  const shellDecision = shellLedger.listEvents({ kind: "workspace_policy.decision", limit: 30 })
    .map((event) => event.payload as { result?: string; effects?: Array<{ kind?: string; decision?: string }> })
    .find((decision) => decision.result === "allow"
      && decision.effects?.every((effect) => effect.kind === "read" && effect.decision === "allow"));
  shellLedger.close();
  assert.ok(shellDecision, "read-only shell effects must still pass through workspace policy before explicit fallback approval");


  for (const command of [
    "find . -maxdepth 3 -type f | sort | head -250 && printf '\n--- package ---\n' && test -f package.json",
    "rg -n -i 'demo|walkthrough|showcase|golden path' --glob '!node_modules/**' . | head -300",
    "find apps packages tests scripts docs -maxdepth 4 -type f | sort",
  ]) {
    const allowed = await events.get("tool_call")!({
      toolName: "bash",
      input: { command },
    }, context);
    assert.equal(allowed, undefined, `provider-first discovery must remain advisory for: ${command}`);
  }
  assert.equal(confirms.count, 0, "read-only discovery commands do not need unsandboxed approval");
  assert.ok(notifications.some((message) => /Atelier advisory: prefer current provider evidence/i.test(message)));

  const allowedRawScan = await events.get("tool_call")!({
    toolName: "bash",
    input: { command: "find examples -type f 2>/dev/null; rg -n 'policy' packages | head -20" },
  }, context);
  assert.equal(allowedRawScan, undefined);
  assert.equal(confirms.count, 0);

  const agentStart = await events.get("before_agent_start")!({ systemPrompt: "base" }, context);
  const phaseLedger = new SqliteLedger(testDatabasePath(root));
  const agentContextPhase = phaseLedger.listEvents({ kind: "ui.phase_changed", limit: 30 })
    .find((event) => (event.payload as { operation?: string; state?: string }).operation === "agent.context"
      && (event.payload as { operation?: string; state?: string }).state === "presented");
  phaseLedger.close();
  assert.equal((agentContextPhase?.payload as { surface?: string } | undefined)?.surface, "native_working_indicator");
  assert.match(agentStart?.systemPrompt ?? "", /Provider-first retrieval is the default/i);
  assert.match(agentStart?.systemPrompt ?? "", /Raw repository inspection remains available/i);
  assert.match(agentStart?.systemPrompt ?? "", /## Retrieval session/);
  assert.deepEqual(activeTools.slice(0, 4), ["atlr_code_search", "atlr_code_symbols", "atlr_code_status", "atlr_validate"]);
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
    toolCallId: "typed-fallback",
    toolName: "find",
    input: { path: root, pattern: "*.ts" },
  }, context);
  assert.equal(allowedFallback, undefined);
  assert.equal(confirms.count, 0, "typed reads and safe shell reads do not add approval prompts");

  await events.get("session_shutdown")!({}, context);
});

test("Atelier footer refreshes model and thinking-level selections immediately", async () => {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  let thinkingLevel = "high";
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void {
      events.set(name, handler);
    },
    registerCommand(): void {},
    registerTool(): void {},
    getThinkingLevel(): string { return thinkingLevel; },
    getActiveTools(): string[] { return ["read", "bash", "edit", "write"]; },
    setActiveTools(): void {},
    sendUserMessage(): void {},
  } as unknown as ExtensionAPI;
  atelierExtension(fakePi);

  const root = createTemporaryRepository("atlr-footer-runtime-");
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "none",
    repositoryProvider: "git",
    codeProvider: "disabled",
  }));
  const sharedSession = {};
  const footers: string[] = [];
  const confirms = { count: 0 };
  const highContext = fakeContext(root, confirms, [], {
    footers,
    modelId: "model-one",
    thinkingLevel: "high",
    sessionKey: sharedSession,
  });
  try {
    await events.get("session_start")!({}, highContext);
    assert.match(footers.at(-1) ?? "", /Atelier: model-one · high/);

    thinkingLevel = "off";
    const offContext = fakeContext(root, confirms, [], {
      footers,
      modelId: "model-one",
      thinkingLevel: "off",
      sessionKey: sharedSession,
    });
    await events.get("thinking_level_select")!({ level: "off", previousLevel: "high" }, offContext);
    assert.match(footers.at(-1) ?? "", /Atelier: model-one · off/);
    assert.doesNotMatch(footers.at(-1) ?? "", /· high ·/);

    const modelContext = fakeContext(root, confirms, [], {
      footers,
      modelId: "model-two",
      thinkingLevel: "off",
      sessionKey: sharedSession,
    });
    await events.get("model_select")!({
      model: { id: "model-two" },
      previousModel: { id: "model-one" },
      source: "cycle",
    }, modelContext);
    assert.match(footers.at(-1) ?? "", /Atelier: model-two · off/);
    const footerLedger = new SqliteLedger(testDatabasePath(root));
    const footerEvidence = footerLedger.listEvents({ kind: "ui.footer_presented", limit: 20 })
      .map((event) => event.payload as { model?: string; thinkingLevel?: string; rendered?: { text?: string } });
    assert.ok(footerEvidence.some((event) => event.model === "model-one" && event.thinkingLevel === "high"));
    assert.ok(footerEvidence.some((event) => event.model === "model-one" && event.thinkingLevel === "off"));
    assert.ok(footerEvidence.some((event) => event.model === "model-two" && event.thinkingLevel === "off"));
    footerLedger.close();
  } finally {
    await events.get("session_shutdown")!({}, highContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct user shell refreshes VCS dirtiness and index freshness", async () => {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const commands = new Map<string, RegisteredCommand>();
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void {
      events.set(name, handler);
    },
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(): void {},
    getThinkingLevel(): string { return "medium"; },
    getActiveTools(): string[] { return ["read", "bash", "edit", "write"]; },
    setActiveTools(): void {},
    sendUserMessage(): void {},
  } as unknown as ExtensionAPI;
  atelierExtension(fakePi);

  const root = createTemporaryRepository("atlr-footer-vcs-intel-");
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "none",
    repositoryProvider: "git",
    codeProvider: "mock",
    sandboxBackend: "none",
  }));
  const footers: string[] = [];
  const context = fakeContext(root, { count: 0 }, [], {
    footers,
    thinkingLevel: "medium",
    confirmResult: true,
  });
  try {
    await events.get("session_start")!({}, context);
    for (let attempt = 0; attempt < 50 && !/intel: ready/.test(footers.at(-1) ?? ""); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const add = spawnSync("git", ["add", "-A"], { cwd: root, encoding: "utf8", shell: false });
    assert.equal(add.status, 0, add.stderr || add.stdout);
    const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: root, encoding: "utf8", shell: false });
    if (staged.status === 1) {
      const commit = spawnSync(
        "git",
        ["commit", "--quiet", "--no-gpg-sign", "-m", "test: establish clean footer baseline"],
        { cwd: root, encoding: "utf8", shell: false },
      );
      assert.equal(commit.status, 0, commit.stderr || commit.stdout);
    }
    await events.get("input")!({ text: "Refresh the clean baseline.", source: "interactive" }, context);
    await waitForCondition(
      () => /git: (?:main|master) · ✓ clean/.test(footers.at(-1) ?? ""),
      `footer did not observe the clean test baseline: ${footers.at(-1) ?? "none"}`,
    );
    await commands.get("code-index")!.handler("", context);
    assert.match(footers.at(-1) ?? "", /git: (?:main|master) · ✓ clean/);
    assert.match(footers.at(-1) ?? "", /intel: ready/);

    const userBash = await events.get("user_bash")!({
      command: "printf '\\nfooter refresh mutation\\n' >> README.md",
      excludeFromContext: false,
      cwd: root,
    }, context) as {
      operations?: {
        exec(
          command: string,
          cwd: string,
          options: { onData(chunk: Buffer): void },
        ): Promise<unknown>;
      };
    };
    assert.ok(userBash.operations, "Atelier user_bash operations were not returned");
    await userBash.operations.exec(
      "printf '\nfooter refresh mutation\n' >> README.md",
      root,
      { onData(): void {} },
    );
    assert.match(footers.at(-1) ?? "", /git: (?:main|master) · ● dirty/);
    assert.match(footers.at(-1) ?? "", /intel: degraded/);

    await commands.get("code-index")!.handler("", context);
    assert.match(footers.at(-1) ?? "", /intel: ready/);
  } finally {
    await events.get("session_shutdown")!({}, context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the next Pi input refreshes repository and intelligence state changed while idle", async () => {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const commands = new Map<string, RegisteredCommand>();
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void {
      events.set(name, handler);
    },
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(): void {},
    getThinkingLevel(): string { return "low"; },
    getActiveTools(): string[] { return ["read", "bash", "edit", "write"]; },
    setActiveTools(): void {},
    sendUserMessage(): void {},
  } as unknown as ExtensionAPI;
  atelierExtension(fakePi);

  const root = createTemporaryRepository("atlr-footer-idle-drift-");
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "none",
    repositoryProvider: "git",
    codeProvider: "mock",
  }));
  const footers: string[] = [];
  let idleDriftObservationArmed = false;
  let resolveRefreshedFooter!: (footer: string) => void;
  const refreshedFooter = new Promise<string>((resolve) => { resolveRefreshedFooter = resolve; });
  const context = fakeContext(root, { count: 0 }, [], {
    footers,
    thinkingLevel: "low",
    onFooter: (footer) => {
      if (
        idleDriftObservationArmed
        && /git: (?:main|master) · ● dirty/.test(footer)
        && /intel: degraded/.test(footer)
      ) {
        resolveRefreshedFooter(footer);
      }
    },
  });
  try {
    await events.get("session_start")!({}, context);
    const add = spawnSync("git", ["add", "-A"], { cwd: root, encoding: "utf8", shell: false });
    assert.equal(add.status, 0, add.stderr || add.stdout);
    const commit = spawnSync(
      "git",
      ["commit", "--quiet", "--no-gpg-sign", "-m", "test: establish idle refresh baseline"],
      { cwd: root, encoding: "utf8", shell: false },
    );
    assert.equal(commit.status, 0, commit.stderr || commit.stdout);
    await commands.get("code-index")!.handler("", context);
    assert.match(footers.at(-1) ?? "", /git: (?:main|master) · ✓ clean/);
    assert.match(footers.at(-1) ?? "", /intel: ready/);

    idleDriftObservationArmed = true;
    writeFileSync(join(root, "README.md"), "changed outside Pi while idle\n", { flag: "a" });
    events.get("input")!({ text: "inspect current state", source: "interactive" }, context);
    let timeout: NodeJS.Timeout | undefined;
    const footer = await Promise.race([
      refreshedFooter,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for the idle-drift footer refresh. Last footer:\n${footers.at(-1) ?? "none"}`));
        }, 30_000);
        timeout.unref();
      }),
    ]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    assert.match(footer, /git: (?:main|master) · ● dirty/);
    assert.match(footer, /intel: degraded/);
  } finally {
    await events.get("session_shutdown")!({}, context);
    rmSync(root, { recursive: true, force: true });
  }
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
  let openedCore: AtelierCore | undefined;
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
      openedCore = core;
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
    openedCore!.code.invalidateStatus();
    const invalidated = await execute("atlr_code_search", { query: "Locate KnownSymbol and MissingSymbol", mode: "semantic" });
    assert.equal((invalidated.details as any).retrieval.lastDecision.kind, "invalidated");
    assert.ok((invalidated.details as any).retrieval.invalidations.length >= 1);

    provider.degraded = true;
    openedCore!.code.invalidateStatus();
    const degraded = await execute("atlr_code_search", { query: "Different degraded discovery" });
    assert.equal((degraded.details as any).status.degraded, true);
    const rawAfterDegradation = await events.get("tool_call")!({ toolName: "bash", input: { command: "rg -n KnownSymbol ." } }, context);
    assert.equal(rawAfterDegradation, undefined);

    const denied = await execute("atlr_code_search", { query: "One request beyond budget" });
    assert.equal((denied.details as any).retrieval.lastDecision.kind, "budget_denied");
    const rawAfterBudget = await events.get("tool_call")!({ toolName: "bash", input: { command: "rg -n KnownSymbol ." } }, context);
    assert.equal(rawAfterBudget, undefined, "budget exhaustion does not create a raw-discovery dead end");

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
      const ledger = new SqliteLedger(testDatabasePath(root));
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
  const lifecycle: string[] = [];
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(): void {},
    getActiveTools(): string[] { return []; },
    setActiveTools(): void {},
    sendUserMessage(message: string): void {
      lifecycle.push("planning-turn-dispatched");
      sentMessages.push(message);
    },
  } as unknown as ExtensionAPI;
  atelierExtension(fakePi);

  const root = createTemporaryRepository("atlr-pi-plan-command-");
  mkdirSync(join(root, ".atelier"), { recursive: true });
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "none",
    repositoryProvider: "git",
    codeProvider: "disabled",
  }));
  writeFileSync(join(root, ".atelier", "validation.json"), JSON.stringify({
    validations: {
      "manual-acceptance": {
        command: [process.execPath, "--version"],
        category: "focused",
        focused: true,
        required: true,
        paths: ["packages/core/src/version.ts", "tests/version.test.ts"],
      },
    },
  }));
  const workingMessages: Array<string | undefined> = [];
  const widgetEvents: Array<{ key: string; content: unknown; placement?: "aboveEditor" | "belowEditor" }> = [];
  const statusEvents: Array<{ key: string; value: string | undefined }> = [];
  const baseContext = fakeContext(root, { count: 0 }, [], {
    workingMessages,
    widgetEvents,
    statusEvents,
  });
  const originalSetWidget = baseContext.ui.setWidget?.bind(baseContext.ui);
  baseContext.ui.setWidget = (key, content, options) => {
    if (key === "atelier-phase" && content !== undefined) lifecycle.push("planning-phase-presented");
    originalSetWidget?.(key, content, options);
  };
  const context = {
    ...baseContext,
    waitForIdle: () => new Promise<void>(() => {}),
  } as ExtensionCommandContext;

  try {
    await commands.get("plan")!.handler("continue building Atelier", context);
    assert.match(sentMessages.at(-1) ?? "", /Atelier PLAN MODE/);
    assert.match(sentMessages.at(-1) ?? "", /Objective: continue building Atelier/);
    assert.match(sentMessages.at(-1) ?? "", /manual-acceptance/);
    assert.match(sentMessages.at(-1) ?? "", /Do not substitute an unconfigured command such as typecheck/);
    assert.match(sentMessages.at(-1) ?? "", /packages\/core\/src\/version\.ts/);
    assert.match(sentMessages.at(-1) ?? "", /do not inspect package manifests or start provider search/i);
    assert.ok(
      lifecycle.indexOf("planning-phase-presented") >= 0
        && lifecycle.indexOf("planning-phase-presented") < lifecycle.indexOf("planning-turn-dispatched"),
      "the visible planning phase must be installed before the planning turn is dispatched",
    );
    assert.match(
      workingMessages.find((message) => /starting planning/i.test(message ?? "")) ?? "",
      /starting planning/i,
    );
    const planLedger = new SqliteLedger(testDatabasePath(root));
    const planPhases = planLedger.listEvents({ kind: "ui.phase_changed", limit: 20 })
      .map((event) => event.payload as { state?: string; operation?: string });
    assert.ok(planPhases.some((phase) => phase.state === "presented" && phase.operation === "plan.command"));
    planLedger.close();
  } finally {
    await events.get("session_shutdown")!({}, context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi automatic ManualEdit review presents exact approval and supports cancellation", async () => {
  const commands = new Map<string, RegisteredCommand>();
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const sentMessages: string[] = [];
  const reportEntries: string[] = [];
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(): void {},
    registerEntryRenderer(): void {},
    appendEntry(_customType: string, data: { markdown?: string }): void {
      if (typeof data.markdown === "string") reportEntries.push(data.markdown);
    },
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
  const widgets: string[][] = [];
  const workingMessages: Array<string | undefined> = [];
  const widgetEvents: Array<{ key: string; content: unknown; placement?: "aboveEditor" | "belowEditor" }> = [];
  const statusEvents: Array<{ key: string; value: string | undefined }> = [];
  const baseContext = fakeContext(root, confirms, [], {
    confirmationBodies,
    notifications,
    widgets,
    workingMessages,
    widgetEvents,
    statusEvents,
  });
  let waitForIdleObservedPhase = false;
  const context = {
    ...baseContext,
    waitForIdle: async () => {
      waitForIdleObservedPhase = widgets.some((lines) => /waiting for Pi to become idle/i.test(lines.join("\n")));
    },
  } as ExtensionCommandContext;

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

    const sentBeforeApproval = sentMessages.length;
    await commands.get("approve")!.handler("", context);
    assert.equal(waitForIdleObservedPhase, true, "approval feedback must render before waiting for Pi idle state");
    assert.equal(confirms.count, 1);
    assert.match(confirmationBodies[0] ?? "", /Review the complete transaction and task-constraint summary shown above/i);
    const approvalSummary = notifications.find((message) => /Plan hash:/i.test(message) && /Provider:/i.test(message)) ?? "";
    assert.match(approvalSummary, /Provider:/i);
    assert.match(approvalSummary, /Operations:/i);
    assert.match(approvalSummary, /Proposed first task:/i);
    assert.match(approvalSummary, /Expected writes: packages\/core, src, src\.ts/i);
    assert.match(approvalSummary, /Dependency changes: excluded/i);
    assert.match(approvalSummary, /Full suite: excluded/i);
    assert.match(approvalSummary, /Filesystem approval is decided separately from concrete workspace effects and recoverability/i);
    assert.ok(widgets.some((lines) => lines.join("\n").includes("Atelier exact execution transaction")));
    assert.ok(widgets.some((lines) => /preparing exact transaction/i.test(lines.join("\n"))));
    assert.equal(statusEvents.some((event) => event.key === "atlr-phase"), false,
      "transient phases must not replace the durable footer mode field");
    assert.equal(sentMessages.length, sentBeforeApproval, "approval must remain idle and must not enqueue implementation");
    assert.ok(notifications.some((message) => /Atelier is idle; send an explicit implementation instruction/i.test(message)));

    const approvalLedger = new SqliteLedger(testDatabasePath(root));
    const approvalPhases = approvalLedger.listEvents({ kind: "ui.phase_changed", limit: 100 })
      .map((event) => event.payload as { state?: string; operation?: string });
    for (const operation of [
      "approve.wait_idle",
      "approve.provider",
      "approve.prepare",
      "approve.revalidate",
      "approve.reconcile",
      "approve.converge",
      "approve.activate",
      "approve.status",
    ]) {
      assert.ok(
        approvalPhases.some((phase) => phase.state === "presented" && phase.operation === operation),
        `missing visible approval phase ${operation}`,
      );
    }
    approvalLedger.close();

    await commands.get("status")!.handler("", context);
    assert.ok(reportEntries.some((message) => /execution_.*active/i.test(message)));
    assert.ok(reportEntries.some((message) => /^### Next action/m.test(message)));
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
  await setup.close();
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
  const tools = new Map<string, RegisteredTool>();
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(tool: RegisteredTool): void { tools.set(tool.name, tool); },
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
  writeFileSync(join(root, ".atelier", "PLAN.md"), VALID_PLAN.replaceAll('"validations":[],"allowFullSuite":false', '"validations":["focused"],"allowFullSuite":false'), "utf8");
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
  await setup.close();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "abort.ts"), "export const abort = true;\n", "utf8");

  const controller = new AbortController();
  const notifications: string[] = [];
  const context = fakeContext(root, { count: 0 }, [], { notifications, signal: controller.signal });
  try {
    assert.ok(tools.has("atlr_validate"), "the model must have a typed validation tool");
    const planAuthorization = await events.get("tool_call")!({
      toolCallId: "validation-plan",
      toolName: "atlr_validate",
      input: { action: "plan" },
    }, context);
    assert.equal(planAuthorization, undefined);
    const planResult = await tools.get("atlr_validate")!.execute(
      "validation-plan",
      { action: "plan" },
      controller.signal,
      undefined,
      context,
    );
    assert.match(planResult.content[0]?.text ?? "", /Focused selection .*focused.*required/is);

    const focusedAuthorization = await events.get("tool_call")!({
      toolCallId: "validation-focused",
      toolName: "atlr_validate",
      input: { action: "focused" },
    }, context);
    assert.equal(focusedAuthorization, undefined);
    const pending = tools.get("atlr_validate")!.execute(
      "validation-focused",
      { action: "focused" },
      controller.signal,
      undefined,
      context,
    );
    setTimeout(() => controller.abort(), 50);
    const focusedResult = await pending;
    assert.match(focusedResult.content[0]?.text ?? "", /focused: interrupted/i);
    assert.equal(context.isIdle(), true);
  } finally {
    await events.get("session_shutdown")!({}, context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi act mode requires execution-linked permissions and still prompts for destructive commands", async () => {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const commands = new Map<string, RegisteredCommand>();
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
  await setup.close();
  const confirms = { count: 0 };
  const statuses: string[] = [];
  const confirmationBodies: string[] = [];
  const notifications: string[] = [];
  const widgets: string[][] = [];
  const footers: string[] = [];
  let idle = true;
  let abortCount = 0;
  let waitForIdleCount = 0;
  const context = fakeContext(root, confirms, statuses, {
    confirmationBodies,
    notifications,
    widgets,
    footers,
    renderCustom: true,
    isIdle: () => idle,
    abort: () => { abortCount += 1; idle = true; },
    waitForIdle: async () => { waitForIdleCount += 1; },
  });

  try {
    await commands.get("status")!.handler("", context);
    for (const command of ["atelier-stop", "atelier-pause", "atelier-resume", "cancel"]) {
      assert.ok(commands.has(command), `missing active-execution control /${command}`);
    }

    idle = false;
    await commands.get("atelier-stop")!.handler("", context);
    assert.equal(abortCount, 1, "/atelier-stop must abort an active turn without revoking execution");
    let controlLedger = new SqliteLedger(testDatabasePath(root));
    assert.ok(controlLedger.getActiveExecutionGrant());
    controlLedger.close();

    idle = false;
    await commands.get("atelier-pause")!.handler("manual pause regression", context);
    assert.equal(abortCount, 2, "/atelier-pause must abort an active turn");
    assert.match(footers.at(-1) ?? "", /mode: paused/, "pause must update the footer synchronously");
    controlLedger = new SqliteLedger(testDatabasePath(root));
    assert.equal(controlLedger.getCurrentWorkflowRun()?.checkpoint, "paused");
    controlLedger.close();
    await commands.get("atelier-resume")!.handler("", context);
    assert.match(footers.at(-1) ?? "", /mode: act/, "resume must update the footer synchronously");
    assert.doesNotMatch(footers.at(-1) ?? "", /execution is paused|Resume execution/i,
      "resume must not retain optimistic paused-state details");
    controlLedger = new SqliteLedger(testDatabasePath(root));
    assert.equal(controlLedger.getCurrentWorkflowRun()?.checkpoint, "executing");
    controlLedger.close();
    assert.equal(waitForIdleCount, 0, "active-execution controls must not wait for Pi idle state");

    await events.get("input")!({
      text: "Use only read, edit, and write. Do not use Bash, do not run validation, do not commit, do not close the task, then stop.",
    }, context);
    const confirmationsBeforeUserPolicy = confirms.count;
    for (const [toolName, input, pattern] of [
      ["bash", { command: "node --test" }, /prohibits Bash/i],
      ["atlr_validate", { action: "focused" }, /prohibits validation or tests/i],
      ["atlr_commit", { message: "test: forbidden" }, /prohibits creating a commit/i],
      ["atlr_task_close", { reason: "forbidden" }, /prohibits closing the task/i],
    ] as const) {
      const blocked = await events.get("tool_call")!({
        toolCallId: `user-policy-${toolName}`,
        toolName,
        input,
      }, context);
      assert.equal(blocked?.block, true);
      assert.match(blocked?.reason ?? "", pattern);
    }
    assert.equal(confirms.count, confirmationsBeforeUserPolicy, "an explicit user prohibition must block before exceptional approval");
    controlLedger = new SqliteLedger(testDatabasePath(root));
    assert.equal(controlLedger.listEvents({ kind: "policy.user_constraint_blocked" }).length, 4);
    controlLedger.close();
    await events.get("input")!({ text: "Continue with normal authorized operations." }, context);

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
    assert.equal(
      statuses.length,
      statusCountBeforeResult,
      "tool completion must not synchronously start a footer/status observation",
    );
    // Wall-clock thresholds inside the aggregate suite are scheduler-sensitive
    // and can fail under unrelated Git/process contention. The deterministic
    // contract is that tool_result does not initiate presentation I/O; the
    // dedicated interactive-performance tests cover event-loop responsiveness.
    let evidenceLedger = new SqliteLedger(testDatabasePath(root));
    assert.equal(evidenceLedger.getExecutionEvidence("edit-routine")?.status, "succeeded");
    evidenceLedger.close();
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
    evidenceLedger = new SqliteLedger(testDatabasePath(root));
    assert.equal(evidenceLedger.getExecutionEvidence("edit-failed")?.status, "failed");
    evidenceLedger.close();
    assert.equal(await events.get("tool_call")!({
      toolCallId: "bash-check",
      toolName: "bash",
      input: { command: "mise run check" },
    }, context), undefined);
    await events.get("tool_result")!({
      toolCallId: "bash-check",
      toolName: "bash",
      content: [{ type: "text", text: "ReferenceError: signal is not defined\nCommand exited with code 1" }],
      isError: true,
    }, context);
    evidenceLedger = new SqliteLedger(testDatabasePath(root));
    assert.equal(evidenceLedger.getExecutionEvidence("bash-check")?.status, "failed");
    evidenceLedger.close();
    assert.equal(await events.get("tool_call")!({
      toolCallId: "bash-commit",
      toolName: "bash",
      input: { command: "git commit -am 'finish task'" },
    }, context), undefined);
    assert.equal(confirms.count, 2, "each generic shell command requires a single-operation approval");

    assert.equal(await events.get("tool_call")!({
      toolCallId: "bash-destructive",
      toolName: "bash",
      input: { command: "rm -rf build" },
    }, context), undefined);
    assert.equal(confirms.count, 3);

    mkdirSync(join(root, "packages", "core", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "core", "src", "completion-guard.ts"), "export const pending = true;\n");
    await commands.get("review-diff")!.handler("", context);
    const reviewSurface = widgets.at(-1)?.join("\n") ?? "";
    assert.match(reviewSurface, /packages\/core\/src\/completion-guard\.ts/);
    assert.match(reviewSurface, /Diff SHA-256:/);
    assert.equal(confirms.count, 3, "the dedicated diff surface must not fall back to a generic confirmation prompt");
    const sentBeforeSettle = sentMessages.length;
    for (let index = 0; index < 5; index += 1) await events.get("agent_settled")!({}, context);
    assert.equal(sentMessages.length, sentBeforeSettle, "an incomplete task must not enqueue a follow-up agent turn");
    assert.equal(
      notifications.filter((message) => /remains active but incomplete/i.test(message)).length,
      1,
      "the passive incomplete-task notice must be deduplicated",
    );

    idle = false;
    await commands.get("cancel")!.handler("manual user-control regression", context);
    assert.equal(abortCount, 3, "/cancel must abort an active turn");
    assert.equal(waitForIdleCount, 0, "/cancel must not wait for an idle state it is responsible for creating");
    const cancelledLedger = new SqliteLedger(testDatabasePath(root));
    assert.equal(cancelledLedger.getActiveExecutionGrant(), undefined);
    cancelledLedger.close();
  } finally {
    // Cleanup must never replace the original assertion with a secondary
    // "missing evidence" failure when the test exits before later tool calls.
    await events.get("session_shutdown")!({}, context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a denied operation leaves an incomplete active task paused without starting another agent turn", async () => {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const commands = new Map<string, RegisteredCommand>();
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

  const root = createTemporaryRepository("atlr-pi-denied-pause-");
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "memory",
    repositoryProvider: "git",
    codeProvider: "disabled",
  }));
  writeFileSync(join(root, ".atelier", "PLAN.md"), VALID_PLAN, "utf8");
  const setup = AtelierCore.open(root, { taskProvider: "memory" });
  setup.beginPlan("Deny one shell operation");
  const review = setup.beginPlanReview();
  setup.completePlanReview(review.id, { exitCode: 0 });
  const prepared = await setup.execution.prepare();
  const started = await setup.execution.approveAndApply(prepared.approval.id, true);
  assert.ok(started.task);
  await setup.close();

  const notifications: string[] = [];
  const context = fakeContext(root, { count: 0 }, [], { notifications, confirmResult: false });
  try {
    const denied = await events.get("tool_call")!({
      toolCallId: "denied-shell",
      toolName: "bash",
      input: { command: "node --test" },
    }, context);
    assert.equal(denied?.block, true);
    assert.match(denied?.reason ?? "", /user denied/i);

    for (let index = 0; index < 5; index += 1) await events.get("agent_settled")!({}, context);
    assert.equal(sentMessages.length, 0, "denial must not enqueue a synthetic follow-up user message");
    assert.equal(notifications.filter((message) => /remains active but incomplete/i.test(message)).length, 1);

    const ledger = new SqliteLedger(testDatabasePath(root));
    assert.ok(ledger.getActiveExecutionGrant(), "the task remains active and paused until explicit cancellation or closure");
    ledger.close();
  } finally {
    await events.get("session_shutdown")!({}, context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit per-turn no-Bash/no-validation/no-commit/no-close instruction is enforced as policy", async () => {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(): void {},
    registerTool(): void {},
    getActiveTools(): string[] { return ["read", "edit", "write", "bash"]; },
    setActiveTools(): void {},
    sendUserMessage(): void {},
  } as unknown as ExtensionAPI;

  const root = createTemporaryRepository("atlr-pi-turn-policy-");
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "memory",
    repositoryProvider: "git",
    codeProvider: "disabled",
    // Keep this assertion platform-independent. macOS normally has Seatbelt,
    // while CI hosts may have Bubblewrap or no sandbox at all.
    sandboxBackend: "none",
  }));
  writeFileSync(join(root, ".atelier", "PLAN.md"), VALID_PLAN, "utf8");
  const sharedProvider = new InMemoryTaskProvider();
  registerAtelierExtension(fakePi, {
    openCore: (repositoryRoot) => AtelierCore.open(repositoryRoot, { taskProviderInstance: sharedProvider }),
  });
  const setup = AtelierCore.open(root, { taskProviderInstance: sharedProvider });
  setup.beginPlan("Enforce current-turn tool constraints");
  const review = setup.beginPlanReview();
  setup.completePlanReview(review.id, { exitCode: 0 });
  const prepared = await setup.execution.prepare();
  await setup.execution.approveAndApply(prepared.approval.id, true);
  await setup.close();

  const confirms = { count: 0 };
  const context = fakeContext(root, confirms, [], { confirmResult: true });
  try {
    await events.get("input")!({
      text: "Use only read, edit, and write. Do not use Bash, do not run validation, do not commit, and do not close the task. Then stop.",
    }, context);

    const prompt = await events.get("before_agent_start")!({ systemPrompt: "base" }, context);
    assert.match(prompt.systemPrompt, /Atelier current-turn hard policy/i);
    assert.match(prompt.systemPrompt, /Bash\/shell/i);
    assert.match(prompt.systemPrompt, /validation\/tests/i);
    assert.match(prompt.systemPrompt, /commit\/local change/i);
    assert.match(prompt.systemPrompt, /task closure/i);

    const outsideMarker = join(root, "..", `${root.split("/").at(-1)}-blocked-outside`);
    for (const [toolName, input] of [
      ["bash", { command: `printf blocked > '${outsideMarker}'` }],
      ["atlr_validate", { action: "focused" }],
      ["atlr_commit", { message: "test: forbidden" }],
      ["atlr_task_close", { reason: "forbidden" }],
    ] as const) {
      const result = await events.get("tool_call")!({ toolCallId: `blocked-${toolName}`, toolName, input }, context);
      assert.equal(result?.block, true, `${toolName} must be blocked by the current user constraint`);
      assert.match(result?.reason ?? "", /current user turn explicitly prohibits/i);
    }
    assert.equal(confirms.count, 0, "a hard user constraint must not be weakened into an approval prompt");

    const edit = await events.get("tool_call")!({
      toolCallId: "allowed-edit",
      toolName: "edit",
      input: { path: "src/index.ts" },
    }, context);
    assert.equal(edit, undefined);

    const ledger = new SqliteLedger(testDatabasePath(root));
    assert.equal(ledger.listEvents({ kind: "policy.user_constraint_blocked" }).length, 4);
    const outsideDecision = ledger.listEvents({ kind: "workspace_policy.decision", limit: 20 })
      .map((event) => event.payload as {
        result?: string;
        effects?: Array<{ state?: string; path?: string; resolvedPath?: string }>;
      })
      .find((decision) => decision.result === "ask"
        && decision.effects?.some((effect) => effect.state === "outside_workspace"
          // The policy payload intentionally preserves the caller-facing lexical
          // path while resolvedPath uses canonical filesystem identity. On macOS,
          // those may be /var/... and /private/var/... for the same entry.
          && effect.path === outsideMarker));
    assert.ok(outsideDecision, "workflow-first denial must still record the concrete outside-workspace consequence");
    ledger.close();

    await events.get("agent_settled")!({}, context);
    const afterSettle = await events.get("tool_call")!({
      toolCallId: "bash-after-settle",
      toolName: "bash",
      input: { command: "printf ok" },
    }, context);
    assert.equal(afterSettle, undefined, "the next turn returns to ordinary workspace-recoverability semantics");
    assert.equal(confirms.count, 0, "a clearly read-only command remains approval-free after the turn policy clears");
  } finally {
    await events.get("session_shutdown")!({}, context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi keeps independent repository state for concurrent sessions and closes each session explicitly", async () => {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const commands = new Map<string, RegisteredCommand>();
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(): void {},
    getActiveTools(): string[] { return []; },
    setActiveTools(): void {},
    sendUserMessage(): void {},
  } as unknown as ExtensionAPI;
  registerAtelierExtension(fakePi);

  const firstRoot = createTemporaryRepository("atlr-pi-session-first-");
  const secondRoot = createTemporaryRepository("atlr-pi-session-second-");
  for (const root of [firstRoot, secondRoot]) {
    writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
      taskProvider: "none",
      repositoryProvider: "git",
      codeProvider: "disabled",
    }), "utf8");
  }
  const first = Object.assign(fakeContext(firstRoot, { count: 0 }), { sessionManager: {} });
  const second = Object.assign(fakeContext(secondRoot, { count: 0 }), { sessionManager: {} });

  try {
    await events.get("session_start")!({}, first);
    await events.get("session_start")!({}, second);
    await commands.get("plan")!.handler("first-session-only objective", first);

    const firstPrompt = await events.get("before_agent_start")!({ systemPrompt: "base" }, first);
    const secondPrompt = await events.get("before_agent_start")!({ systemPrompt: "base" }, second);
    assert.match(firstPrompt.systemPrompt, /Only .*PLAN\.md may be modified/);
    assert.match(secondPrompt.systemPrompt, /Investigate only/);
    assert.doesNotMatch(secondPrompt.systemPrompt, /first-session-only objective/);

    await events.get("session_shutdown")!({}, first);
    const survivingPrompt = await events.get("before_agent_start")!({ systemPrompt: "base" }, second);
    assert.match(survivingPrompt.systemPrompt, /Investigate only/);
  } finally {
    await events.get("session_shutdown")!({}, second);
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("separate Pi extension registrations retain their own Core factories", async () => {
  const firstEvents = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const secondEvents = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const makePi = (events: Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>) => ({
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(): void {},
    registerTool(): void {},
    getActiveTools(): string[] { return []; },
    setActiveTools(): void {},
    sendUserMessage(): void {},
  } as unknown as ExtensionAPI);

  let firstOpens = 0;
  let secondOpens = 0;
  registerAtelierExtension(makePi(firstEvents), {
    openCore: (root) => { firstOpens += 1; return AtelierCore.open(root); },
  });
  registerAtelierExtension(makePi(secondEvents), {
    openCore: (root) => { secondOpens += 1; return AtelierCore.open(root); },
  });

  const firstRoot = createTemporaryRepository("atlr-pi-factory-first-");
  const secondRoot = createTemporaryRepository("atlr-pi-factory-second-");
  for (const root of [firstRoot, secondRoot]) {
    writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
      taskProvider: "none",
      repositoryProvider: "git",
      codeProvider: "disabled",
    }), "utf8");
  }
  const firstContext = Object.assign(fakeContext(firstRoot, { count: 0 }), { sessionManager: {} });
  const secondContext = Object.assign(fakeContext(secondRoot, { count: 0 }), { sessionManager: {} });
  try {
    await firstEvents.get("session_start")!({}, firstContext);
    await secondEvents.get("session_start")!({}, secondContext);
    assert.equal(firstOpens, 1);
    assert.equal(secondOpens, 1);
  } finally {
    await firstEvents.get("session_shutdown")!({}, firstContext);
    await secondEvents.get("session_shutdown")!({}, secondContext);
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("typed workflow tools remain active when code intelligence is disabled", async () => {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const tools = new Map<string, RegisteredTool>();
  let active = ["read", "edit", "write", "bash"];
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(): void {},
    registerTool(tool: RegisteredTool): void { tools.set(tool.name, tool); },
    getActiveTools(): string[] { return [...active]; },
    setActiveTools(names: string[]): void { active = [...names]; },
    sendUserMessage(): void {},
  } as unknown as ExtensionAPI;
  registerAtelierExtension(fakePi);

  const root = createTemporaryRepository("atlr-pi-workflow-tools-without-code-");
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "none",
    repositoryProvider: "git",
    codeProvider: "disabled",
  }), "utf8");
  const context = fakeContext(root, { count: 0 });
  try {
    await events.get("session_start")!({}, context);
    await events.get("before_agent_start")!({ systemPrompt: "base" }, context);
    for (const name of ["atlr_state", "atlr_validate", "atlr_commit", "atlr_task_close"]) {
      assert.ok(tools.has(name), `missing registered workflow tool ${name}`);
      assert.ok(active.includes(name), `workflow tool ${name} must remain active without a code provider`);
    }
    for (const name of ["atlr_code_status", "atlr_code_search", "atlr_code_symbols"]) {
      assert.equal(active.includes(name), false, `disabled code tool ${name} must not be activated`);
    }
  } finally {
    await events.get("session_shutdown")!({}, context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("model Bash and direct user shell share one workspace-policy authorization boundary", async () => {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const tools = new Map<string, RegisteredTool>();
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(): void {},
    registerTool(tool: RegisteredTool): void { tools.set(tool.name, tool); },
    getActiveTools(): string[] { return ["read", "edit", "write", "bash"]; },
    setActiveTools(): void {},
    sendUserMessage(): void {},
  } as unknown as ExtensionAPI;
  registerAtelierExtension(fakePi);

  const root = createTemporaryRepository("atlr-pi-shared-shell-boundary-");
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({
    taskProvider: "none",
    repositoryProvider: "git",
    codeProvider: "disabled",
    sandboxBackend: "none",
  }), "utf8");
  const confirms = { count: 0 };
  const confirmationBodies: string[] = [];
  const workingMessages: Array<string | undefined> = [];
  const context = fakeContext(root, confirms, [], {
    confirmationBodies,
    confirmResults: [false, false],
    workingMessages,
  });
  const outsideMarker = `${root}-outside-write.txt`;
  try {
    await events.get("session_start")!({}, context);
    const bash = tools.get("bash");
    assert.ok(bash, "Atelier must replace Pi Bash with the workspace-aware implementation");
    assert.equal((bash as RegisteredTool & { executionMode?: string }).executionMode, "sequential");

    const authorized = await events.get("tool_call")!({
      toolCallId: "model-read-shell",
      toolName: "bash",
      input: { command: "printf model-ok" },
    }, context);
    assert.equal(authorized, undefined);
    assert.equal(confirms.count, 0, "an unsandboxed parsed read does not require a prompt");
    const modelUpdates: unknown[] = [];
    const modelResult = await bash!.execute(
      "model-read-shell",
      { command: "printf model-ok" },
      new AbortController().signal,
      (update) => { modelUpdates.push(update); },
      context,
    );
    assert.match(modelResult.content.map((item) => item.text).join("\n"), /model-ok/);
    assert.ok(
      modelUpdates.some((update) => JSON.stringify(update).includes("model-ok")),
      "model Bash must emit streamed output before final settlement",
    );
    assert.equal(workingMessages.at(-1), undefined, "model Bash must clear the Atelier working phase after completion");
    await events.get("tool_result")!({
      toolCallId: "model-read-shell",
      toolName: "bash",
      input: { command: "printf model-ok" },
      content: modelResult.content,
      details: modelResult.details,
      isError: false,
    }, context);
    await events.get("agent_settled")!({}, context);

    const failedCommand = "printf model-fail; grep definitely-not-present README.md";
    const failedAuthorization = await events.get("tool_call")!({
      toolCallId: "model-failed-shell",
      toolName: "bash",
      input: { command: failedCommand },
    }, context);
    assert.equal(failedAuthorization, undefined);
    assert.equal(confirms.count, 0);
    await assert.rejects(
      bash!.execute(
        "model-failed-shell",
        { command: failedCommand },
        new AbortController().signal,
        undefined,
        context,
      ),
      /model-fail[\s\S]*exited with code 1/i,
    );
    assert.equal(workingMessages.at(-1), undefined, "failed model Bash must clear the Atelier working phase");
    await events.get("agent_settled")!({}, context);

    const lifecycleLedger = new SqliteLedger(testDatabasePath(root));
    const lifecycle = lifecycleLedger.listEvents({ kind: "ui.model_bash", limit: 10 })
      .map((event) => event.payload as {
        state?: string;
        hadOutput?: boolean;
        outputBytes?: number;
        updateCount?: number;
        output?: { sha256?: string; capturedBytes?: number; truncated?: boolean };
      });
    assert.ok(lifecycle.some((event) => event.state === "started"));
    assert.ok(lifecycle.some((event) => event.state === "succeeded"
      && event.hadOutput === true
      && (event.outputBytes ?? 0) > 0
      && (event.updateCount ?? 0) > 0
      && /^[a-f0-9]{64}$/.test(event.output?.sha256 ?? "")
      && (event.output?.capturedBytes ?? 0) > 0
      && event.output?.truncated === false));
    assert.ok(lifecycle.some((event) => event.state === "failed" && (event.outputBytes ?? 0) > 0));
    assert.ok(lifecycleLedger.listEvents({ kind: "ui.agent_settled", limit: 10 })
      .some((event) => (event.payload as { isIdle?: boolean }).isIdle === true));
    lifecycleLedger.close();

    await assert.rejects(
      bash!.execute(
        "missing-authorization",
        { command: "printf forbidden" },
        new AbortController().signal,
        undefined,
        context,
      ),
      /no matching workspace-policy authorization/i,
    );

    const userRead = await events.get("user_bash")!({ command: "printf user-ok" }, context);
    assert.ok(userRead?.operations);
    let userOutput = "";
    const userResult = await userRead.operations.exec("printf user-ok", root, {
      onData(chunk: Buffer) {
        assert.equal(Buffer.isBuffer(chunk), true, "Pi BashOperations must receive Buffer chunks");
        userOutput += chunk.toString("utf8");
      },
    });
    assert.equal(userResult.exitCode, 0);
    assert.match(userOutput, /user-ok/);
    assert.equal(confirms.count, 0);

    const deniedModel = await events.get("tool_call")!({
      toolCallId: "model-unknown-shell",
      toolName: "bash",
      input: { command: "node unknown-script.js" },
    }, context);
    assert.equal(deniedModel?.block, true);
    assert.match(deniedModel?.reason ?? "", /investigate mode is read-only/i);
    assert.equal(confirms.count, 0, "workflow-denied commands must not prompt or create recovery state");

    const outsideCommand = `printf denied > ${JSON.stringify(outsideMarker)}`;
    const deniedUser = await events.get("user_bash")!({ command: outsideCommand }, context);
    assert.equal(deniedUser?.operations, undefined, "a denied direct shell command must not receive executable operations");
    assert.equal(deniedUser?.result?.exitCode, 126);
    assert.match(deniedUser?.result?.output ?? "", /DENIED BY ATELIER/);
    assert.match(deniedUser?.result?.output ?? "", /command was not executed/i);
    // Mirror Pi's user_bash fallback: without a replacement result or custom
    // operations it executes the command normally. This would expose the old
    // invalid { block, reason } return shape by creating the marker.
    if (deniedUser?.result === undefined && deniedUser?.operations === undefined) {
      spawnSync("/bin/sh", ["-lc", outsideCommand], { cwd: root, encoding: "utf8" });
    }
    assert.equal(existsSync(outsideMarker), false, "a user-denied outside-workspace command must not execute");
    assert.equal(confirms.count, 1, "the outside-workspace consequence still requires one concrete denial");

    const secret = join(root, ".env.acceptance");
    writeFileSync(secret, "ATELIER_SECRET_MUST_NOT_LEAK\n", "utf8");
    const secretCommand = "cat .env.acceptance";
    const deniedSecret = await events.get("user_bash")!({ command: secretCommand }, context);
    assert.equal(deniedSecret?.result?.exitCode, 126);
    assert.match(deniedSecret?.result?.output ?? "", /DENIED BY ATELIER/);
    assert.doesNotMatch(deniedSecret?.result?.output ?? "", /ATELIER_SECRET_MUST_NOT_LEAK/);
    let fallbackOutput = "";
    if (deniedSecret?.result === undefined && deniedSecret?.operations === undefined) {
      fallbackOutput = spawnSync("/bin/sh", ["-lc", secretCommand], { cwd: root, encoding: "utf8" }).stdout ?? "";
    }
    assert.doesNotMatch(fallbackOutput, /ATELIER_SECRET_MUST_NOT_LEAK/, "a user-denied secret read must not execute or expose output");
    assert.equal(readFileSync(secret, "utf8"), "ATELIER_SECRET_MUST_NOT_LEAK\n");
    assert.equal(confirms.count, 2, "likely-secret reads still require one concrete denial");
  } finally {
    await events.get("session_shutdown")!({}, context);
    rmSync(outsideMarker, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi status, workflow, and code commands append expandable persistent report cards", async () => {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const commands = new Map<string, RegisteredCommand>();
  const entries: Array<{ customType: string; data: any }> = [];
  let registeredRenderer: ((entry: any, options: any, theme: any) => any) | undefined;
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(): void {},
    registerEntryRenderer(_type: string, renderer: (entry: any, options: any, theme: any) => any): void { registeredRenderer = renderer; },
    appendEntry(customType: string, data: any): void { entries.push({ customType, data }); },
    getActiveTools(): string[] { return ["read", "bash", "edit", "write"]; },
    setActiveTools(): void {},
    sendUserMessage(): void {},
  } as unknown as ExtensionAPI;

  atelierExtension(fakePi);
  assert.ok(registeredRenderer, "Atelier must register a persistent report renderer");
  const root = createTemporaryRepository("atlr-persistent-reports-");
  mkdirSync(join(root, ".atelier"), { recursive: true });
  writeFileSync(join(root, ".atelier", "config.json"), JSON.stringify({ taskProvider: "none", codeProvider: "disabled" }));
  const context = fakeContext(root, { count: 0 });
  try {
    await events.get("session_start")!({}, context);
    await commands.get("status")!.handler("", context);
    assert.ok(commands.has("workflow"), "Atelier must expose /workflow as the clear durable-state command");
    await commands.get("workflow")!.handler("", context);
    await commands.get("code-status")!.handler("", context);
    assert.equal(entries.length, 3);
    assert.equal(entries[0]?.customType, "atelier-report");
    assert.match(entries[0]?.data.markdown ?? "", /^\*\*workspace:\*\*/m);
    assert.doesNotMatch(entries[0]?.data.markdown ?? "", /^\| field \| value \|/m);
    assert.match(entries[0]?.data.summary ?? "", /investigate/);
    assert.match(entries[1]?.data.markdown ?? "", /^\*\*mode:\*\*/m);
    assert.doesNotMatch(entries[1]?.data.markdown ?? "", /^\*\*workspace:\*\*/m);
    assert.notEqual(entries[1]?.data.markdown, entries[0]?.data.markdown, "/workflow must not duplicate /status");
    assert.match(entries[1]?.data.summary ?? "", /no active task/);
    assert.match(entries[2]?.data.markdown ?? "", /^\*\*provider:\*\*/m);
    assert.match(entries[2]?.data.markdown ?? "", /^\*\*state:\*\* disabled/m);
    const component = registeredRenderer!({ type: "custom", customType: "atelier-report", data: entries[0]?.data }, { expanded: true }, {});
    const rendered = component?.render(100).join("\n") ?? "";
    assert.match(rendered, /▼ Atelier status/);
    assert.match(rendered, /^─+$/m);
    const reportLedger = new SqliteLedger(testDatabasePath(root));
    const reportEvidence = reportLedger.listEvents({ kind: "ui.report_presented", limit: 20 })
      .map((event) => event.payload as { command?: string; markdown?: { sha256?: string } });
    const statusEvidence = reportEvidence.find((event) => event.command === "/status");
    const workflowEvidence = reportEvidence.find((event) => event.command === "/workflow");
    assert.ok(statusEvidence?.markdown?.sha256);
    assert.ok(workflowEvidence?.markdown?.sha256);
    assert.notEqual(statusEvidence?.markdown?.sha256, workflowEvidence?.markdown?.sha256);
    reportLedger.close();
  } finally {
    await events.get("session_shutdown")!({}, context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi /status owns one observation and slash input does not start a competing footer refresh", async () => {
  const events = new Map<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>();
  const commands = new Map<string, RegisteredCommand>();
  const fakePi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void { events.set(name, handler); },
    registerCommand(name: string, command: RegisteredCommand): void { commands.set(name, command); },
    registerTool(): void {},
    getActiveTools(): string[] { return ["read", "bash", "edit", "write"]; },
    setActiveTools(): void {},
    sendUserMessage(): void {},
    appendEntry(): void {},
  } as unknown as ExtensionAPI;
  const root = createTemporaryRepository("atlr-pi-single-status-");
  const core = AtelierCore.open(root, { taskProvider: "memory" });
  let statusCalls = 0;
  const originalStatus = core.status.bind(core);
  (core as any).status = async () => {
    statusCalls += 1;
    return originalStatus();
  };
  registerAtelierExtension(fakePi, { openCore: () => core });
  const context = fakeContext(root, { count: 0 });
  try {
    await events.get("session_start")!({ reason: "startup" }, context);
    await new Promise((resolve) => setTimeout(resolve, 30));
    statusCalls = 0;

    await events.get("input")!({ text: "/status", source: "interactive" }, context);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(statusCalls, 0, "slash input must not start the generic footer observation");

    await commands.get("status")!.handler("", context);
    assert.equal(statusCalls, 1, "the /status report and footer must share one typed status observation");
  } finally {
    await events.get("session_shutdown")!({ reason: "quit" }, context);
    rmSync(root, { recursive: true, force: true });
  }
});
