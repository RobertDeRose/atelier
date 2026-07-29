import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import atelierExtension, { registerAtelierExtension } from "../apps/pi-extension/src/index.ts";
import { executionGrantText, planStatusText, vcsStatusText } from "../apps/pi-extension/src/status-presentation.ts";
import {
  AtelierCore,
  InMemoryTaskProvider,
  MockCodeProvider,
  projectTrustStatus,
  revokeProjectTrust,
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

function fakeContext(
  cwd: string,
  confirms: { count: number },
  statuses: string[] = [],
  observations: {
    confirmationBodies?: string[];
    notifications?: string[];
    widgets?: string[][];
    footers?: string[];
    signal?: AbortSignal;
    isIdle?: () => boolean;
    abort?: () => void;
    waitForIdle?: () => Promise<void>;
    confirmResult?: boolean;
  } = {},
): ExtensionCommandContext {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    isIdle: observations.isIdle ?? (() => true),
    isProjectTrusted: () => true,
    waitForIdle: observations.waitForIdle ?? (async () => {}),
    ...(observations.abort === undefined ? {} : { abort: observations.abort }),
    ...(observations.signal === undefined ? {} : { signal: observations.signal }),
    model: { id: "test-model" },
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    ui: {
      confirm: async (_title: string, body: string) => {
        confirms.count += 1;
        observations.confirmationBodies?.push(body);
        return observations.confirmResult ?? true;
      },
      select: async () => undefined,
      notify: (message: string) => { observations.notifications?.push(message); },
      setStatus: (_key: string, value: string | undefined) => { if (value !== undefined) statuses.push(value); },
      setWidget: (_key: string, content: string[] | undefined) => { if (content !== undefined) observations.widgets?.push(content); },
      setFooter: (factory: any) => {
        if (factory === undefined) return;
        const component = factory({}, {}, {});
        observations.footers?.push(component.render(240).join("\n"));
      },
      custom: async () => ({ exitCode: 0 }),
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

test("Pi reserves /trust while Atelier exposes a working /atelier-trust command", async () => {
  const { events, commands } = registerTrustCommandHarness();
  assert.equal(commands.has("trust"), false, "Pi's built-in /trust command must remain unshadowed");
  assert.ok(commands.has("atelier-trust"));

  const root = createTemporaryRepository("atlr-pi-trust-command-");
  const canonicalRoot = projectTrustStatus(root).root;
  revokeProjectTrust(root);
  const notifications: string[] = [];
  const confirms = { count: 0 };
  const context = fakeContext(root, confirms, [], { notifications });
  try {
    await events.get("session_start")!({}, context);
    assert.equal(projectTrustStatus(root).trusted, false);
    assert.ok(notifications.some((message) => /Use \/atelier-trust\./.test(message)));

    await commands.get("atelier-trust")!.handler("", context);
    assert.equal(confirms.count, 1);
    assert.equal(projectTrustStatus(root).trusted, true);
    assert.ok(notifications.some((message) => message === `Trusted ${canonicalRoot}.`));
  } finally {
    await events.get("session_shutdown")!({}, context);
    revokeProjectTrust(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "Pi /atelier-trust reports one canonical project identity through repository aliases",
  { skip: process.platform === "win32" },
  async () => {
    const { events, commands } = registerTrustCommandHarness();
    const root = createTemporaryRepository("atlr-pi-trust-canonical-");
    const aliasParent = mkdtempSync(join(tmpdir(), "atlr-pi-trust-alias-"));
    const aliasRoot = join(aliasParent, "repository");
    symlinkSync(root, aliasRoot, "dir");
    const canonicalRoot = realpathSync.native(root);
    revokeProjectTrust(aliasRoot);

    const notifications: string[] = [];
    const confirms = { count: 0 };
    const context = fakeContext(aliasRoot, confirms, [], { notifications });
    try {
      const untrusted = projectTrustStatus(aliasRoot);
      assert.equal(untrusted.root, canonicalRoot);
      assert.equal(untrusted.trusted, false);

      await events.get("session_start")!({}, context);
      await commands.get("atelier-trust")!.handler("", context);

      const aliasStatus = projectTrustStatus(aliasRoot);
      const canonicalStatus = projectTrustStatus(root);
      assert.equal(confirms.count, 1);
      assert.equal(aliasStatus.trusted, true);
      assert.equal(canonicalStatus.trusted, true);
      assert.equal(aliasStatus.root, canonicalRoot);
      assert.equal(canonicalStatus.root, canonicalRoot);
      assert.ok(notifications.some((message) => message === `Trusted ${canonicalRoot}.`));
    } finally {
      await events.get("session_shutdown")!({}, context);
      revokeProjectTrust(aliasRoot);
      rmSync(aliasParent, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("Pi extension keeps provider-first discovery advisory while confining typed reads and prompting for shell", async () => {
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
  for (const command of ["atelier-trust", "status", "plan", "review", "approve", "execute", "cancel", "ready", "state", "code-status", "code-index", "code-search", "code-symbols", "changed", "validate", "evidence", "review-diff", "commit", "close"]) {
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
  }));
  const confirms = { count: 0 };
  const statuses: string[] = [];
  const notifications: string[] = [];
  const footers: string[] = [];
  const context = fakeContext(root, confirms, statuses, { notifications, footers });
  await events.get("session_start")!({}, context);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(statuses.some((status) => /index (building|ready)/.test(status)), "Pi footer must expose background index state");
  assert.ok(footers.some((footer) => /git [0-9a-f]{8}/.test(footer)), "custom footer must expose the selected Git provider identity");
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
  assert.equal(confirms.count, 1, "generic shell remains unconfined even when its command appears read-only");
  const shellLedger = new SqliteLedger(testDatabasePath(root));
  const shellDecision = shellLedger.listEvents({ kind: "policy.decision", limit: 20 })
    .map((event) => event.payload as { action?: string; result?: string })
    .find((decision) => decision.action === "command.execute" && decision.result === "allow");
  shellLedger.close();
  assert.ok(shellDecision, "generic Pi shell must be authorized as command.execute even when classification is read-only");


  for (const command of [
    "find . -maxdepth 3 -type f | sort | head -250 && printf '\n--- package ---\n' && test -f package.json && node -e 'console.log(1)'",
    "rg -n -i 'demo|walkthrough|showcase|golden path' --glob '!node_modules/**' . | head -300",
    "find apps packages tests scripts docs -maxdepth 4 -type f | sort",
  ]) {
    const allowed = await events.get("tool_call")!({
      toolName: "bash",
      input: { command },
    }, context);
    assert.equal(allowed, undefined, `provider-first discovery must remain advisory for: ${command}`);
  }
  assert.equal(confirms.count, 4, "each unconfined shell operation requires one explicit approval");
  assert.ok(notifications.some((message) => /Atelier advisory: prefer current provider evidence/i.test(message)));

  const allowedRawScan = await events.get("tool_call")!({
    toolName: "bash",
    input: { command: "find examples -type f 2>/dev/null; rg -n 'policy' packages | head -20" },
  }, context);
  assert.equal(allowedRawScan, undefined);
  assert.equal(confirms.count, 5);

  const agentStart = await events.get("before_agent_start")!({ systemPrompt: "base" }, context);
  assert.match(agentStart?.systemPrompt ?? "", /Provider-first retrieval is advisory/i);
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
  assert.equal(confirms.count, 5, "typed reads within the trusted root do not inherit shell approvals");

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
  const widgets: string[][] = [];
  const context = fakeContext(root, confirms, [], { confirmationBodies, notifications, widgets });

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
    assert.equal(confirms.count, 1);
    assert.match(confirmationBodies[0] ?? "", /Review the complete transaction and capability summary shown above/i);
    const approvalSummary = notifications.find((message) => /Plan hash:/i.test(message) && /Provider:/i.test(message)) ?? "";
    assert.match(approvalSummary, /Provider:/i);
    assert.match(approvalSummary, /Operations:/i);
    assert.match(approvalSummary, /Proposed first task:/i);
    assert.match(approvalSummary, /Writes: packages\/core, src, src\.ts/i);
    assert.match(approvalSummary, /Dependencies: not permitted/i);
    assert.match(approvalSummary, /Full suite: not permitted/i);
    assert.match(approvalSummary, /Generic shell, publication, external effects, and out-of-scope paths: not permitted/i);
    assert.ok(widgets.some((lines) => lines.join("\n").includes("Atelier exact execution transaction")));
    assert.equal(sentMessages.length, sentBeforeApproval, "approval must remain idle and must not enqueue implementation");
    assert.ok(notifications.some((message) => /Atelier is idle; send an explicit implementation instruction/i.test(message)));

    await commands.get("status")!.handler("", context);
    assert.ok(notifications.some((message) => /Execution grant: execution_.*active/i.test(message)));
    assert.ok(notifications.some((message) => /Next action:/i.test(message)));
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
  let idle = true;
  let abortCount = 0;
  let waitForIdleCount = 0;
  const context = fakeContext(root, confirms, statuses, {
    confirmationBodies,
    notifications,
    isIdle: () => idle,
    abort: () => { abortCount += 1; idle = true; },
    waitForIdle: async () => { waitForIdleCount += 1; },
  });

  try {
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
    controlLedger = new SqliteLedger(testDatabasePath(root));
    assert.equal(controlLedger.getCurrentWorkflowRun()?.checkpoint, "paused");
    controlLedger.close();
    await commands.get("atelier-resume")!.handler("", context);
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
    await events.get("tool_result")!({
      toolCallId: "bash-check",
      toolName: "bash",
      content: [{ type: "text", text: "ReferenceError: signal is not defined\nCommand exited with code 1" }],
      isError: true,
    }, context);
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
    assert.match(confirmationBodies.at(-1) ?? "", /packages\/core\/src\/completion-guard\.ts/);
    assert.match(confirmationBodies.at(-1) ?? "", /Diff SHA-256:/);
    assert.equal(confirms.count, 4, "Pi must display and confirm the exact diff before recording review");
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
    await events.get("session_shutdown")!({}, context);
    const ledger = new SqliteLedger(testDatabasePath(root));
    assert.equal(ledger.getExecutionEvidence("edit-routine")?.status, "succeeded");
    assert.equal(ledger.getExecutionEvidence("edit-failed")?.status, "failed");
    assert.equal(ledger.getExecutionEvidence("bash-check")?.status, "failed");
    ledger.close();
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
  const context = fakeContext(root, confirms, [], { confirmResult: false });
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

    for (const [toolName, input] of [
      ["bash", { command: "node --test" }],
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
    ledger.close();

    await events.get("agent_settled")!({}, context);
    const afterSettle = await events.get("tool_call")!({
      toolCallId: "bash-after-settle",
      toolName: "bash",
      input: { command: "printf ok" },
    }, context);
    assert.equal(afterSettle?.block, true);
    assert.match(afterSettle?.reason ?? "", /user denied/i);
    assert.equal(confirms.count, 1, "the next turn returns to ordinary one-operation approval semantics");
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
