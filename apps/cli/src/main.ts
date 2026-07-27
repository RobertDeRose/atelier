#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTION_KINDS,
  AtelierCore,
  PERMISSIONS,
  classifyShellCommand,
  ensurePlanDocument,
  parsePlanFile,
  resolveEditorCommand,
  runInteractiveProcess,
  type ActionKind,
  type Permission,
} from "../../../packages/core/src/index.ts";

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals !== -1) {
      flags.set(arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { positionals, flags };
}

function flagString(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function flagBoolean(args: ParsedArgs, key: string): boolean {
  const value = args.flags.get(key);
  return value === true || value === "true";
}

function asJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function commandAvailable(command: string, args: string[] = ["--version"]): { available: boolean; detail: string } {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, windowsHide: true });
  if (result.error !== undefined) return { available: false, detail: result.error.message };
  return {
    available: result.status === 0,
    detail: (result.stdout || result.stderr || `exit ${result.status}`).trim().split("\n")[0] ?? "",
  };
}

function printHelp(): void {
  process.stdout.write(`Atelier prototype

Usage:
  atlr [--root PATH] <command>

Commands:
  launch [PI_ARGS...]              Launch Pi with the Atelier extension loaded
  init [--beads] [--stealth]       Initialize .atelier state and a plan document
  repo status [--json]             Show the selected repository provider and identity
  doctor                            Check Node, editor, VCS, and Beads availability
  status [--json]                   Show workflow, plan, task-provider, and repository state
  mode <investigate|plan|act>       Change the guarded workflow mode
  plan [OBJECTIVE]                  Enter plan mode and create the plan document if missing
  plan parse [--json]               Parse and validate the plan
  plan reconcile [--apply] [--json] Preview or apply task-provider reconciliation
  review                            Open the plan in the configured editor and record a ManualEdit
  approve                           Approve the current manually reviewed plan revision
  ready [--json]                    Return provider-reported unblocked work
  task show ID [--json]             Read one provider task
  task claim ID                     Atomically claim a task
  task close ID --reason TEXT       Close a task with evidence
  permission list [--json]          List active grants
  permission grant NAME [options]   Grant an explicit permission
  permission revoke ID              Revoke a grant
  policy command "COMMAND"          Classify and evaluate a shell command
  state [--task ID] [--json]        Build deterministic task-backed Working State
  code providers [--json]           List configured code-intelligence providers
  code status [--provider NAME]     Show provider health, capabilities, and index state
  code index [--provider NAME]      Ensure the current workspace is indexed
  code search QUERY [options]       Search code across one or more repositories
  code symbols QUERY [options]      Search symbols when supported by the provider
  code related REFERENCE [options]  Retrieve supported code relationships
  config validate [--json]          Validate workspace and retrieval configuration
  code doctor [--json]              Diagnose code-provider configuration and health
  changed [--json]                  Show paths changed in the current Jujutsu workspace
  validate list [--json]            List configured validations
  validate plan [--json]            Select focused validations for current changes
  validate focused [--json]         Run the selected focused validations
  validate run NAME [--json]        Run a configured validation and persist evidence
  evidence [--name NAME] [--json]   Show validation evidence and freshness
  ledger tail [--limit N] [--json]  Show recent durable events

Code search options:
  --mode auto|semantic|hybrid|lexical
  --focus auto|source|tests|docs|all
  --hint IDENTIFIER[,IDENTIFIER...] Exact identifiers for bounded lexical augmentation

Permission grant options:
  --scope operation|turn|task|session|repository
  --task ID
  --path PATH                       Repeat by using comma-separated paths
  --reason TEXT

Atelier owns the Code provider contract, provenance, and Working State integration. External providers own code indexing.
`);
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  const parsed = parseArgs(raw);
  const requestedRoot = resolve(flagString(parsed, "root") ?? process.cwd());
  const root = existsSync(requestedRoot) ? realpathSync(requestedRoot) : requestedRoot;
  const [command, subcommand, ...rest] = parsed.positionals;

  if (command === undefined || command === "help" || flagBoolean(parsed, "help")) {
    printHelp();
    return;
  }

  if (command === "launch") {
    const commandIndex = raw.indexOf("launch");
    const piArgs = commandIndex === -1 ? [] : raw.slice(commandIndex + 1);
    const extensionPath = fileURLToPath(new URL("../../pi-extension/src/index.ts", import.meta.url));
    const result = spawnSync("pi", ["--extension", extensionPath, ...piArgs], {
      cwd: root,
      env: { ...process.env, ATELIER_ROOT: root },
      stdio: "inherit",
      shell: false,
      windowsHide: false,
    });
    if (result.error !== undefined) {
      throw new Error(`Unable to launch Pi: ${result.error.message}. Install Pi and ensure the pi executable is on PATH.`);
    }
    process.exitCode = result.status ?? 1;
    return;
  }

  if (command === "doctor") {
    const core = AtelierCore.open(root);
    try {
      const status = await core.taskProvider.status();
      const editor = (() => {
        try {
          return resolveEditorCommand(core.config, false);
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      })();
      asJson({
        node: { version: process.version, supported: Number(process.versions.node.split(".")[0]) >= 24 },
        git: commandAvailable("git"),
        jj: commandAvailable("jj"),
        beads: status,
        pi: commandAvailable("pi"),
        editor,
        code: await core.code.status(undefined, core.codeWorkspace()),
        repositoryRoot: root,
      });
    } finally {
      core.close();
    }
    return;
  }

  const core = AtelierCore.open(root);
  try {
    switch (command) {
      case "init": {
        const initialized = core.initialize({ createPlan: true });
        let beads: unknown;
        if (flagBoolean(parsed, "beads")) {
          await core.taskProvider.initialize({ stealth: flagBoolean(parsed, "stealth"), quiet: true });
          beads = await core.taskProvider.status();
          core.ledger.append({
            kind: "task_provider.initialized",
            actor: "user",
            payload: { provider: core.taskProvider.name, stealth: flagBoolean(parsed, "stealth") },
          });
        } else {
          beads = await core.taskProvider.status();
        }
        asJson({ ...initialized, stateDirectory: core.config.stateDirectory, planPath: core.config.planPath, beads });
        return;
      }

      case "config": {
        if (subcommand !== "validate") throw new Error("Usage: atlr config validate [--json]");
        const issues = core.validateConfiguration();
        if (flagBoolean(parsed, "json")) asJson({
          valid: issues.length === 0,
          issues,
          workspace: core.codeWorkspace(),
          retrievalBudgets: {
            providerRequests: core.config.codeMaxProviderRequests,
            results: core.config.codeMaxResults,
            uniquePaths: core.config.codeMaxUniquePaths,
            compactEntries: core.config.codeMaxEvidenceEntries,
            retainedSessions: core.config.codeRetainedSessions,
            persistedEntries: core.config.codeMaxPersistedEntries,
            persistedBytes: core.config.codeMaxPersistedBytes,
          },
        });
        else process.stdout.write(issues.length ? issues.map((issue) => `ERROR: ${issue}`).join("\n") + "\n" : "Configuration valid.\n");
        if (issues.length) process.exitCode = 2;
        return;
      }

      case "repo": {
        if (subcommand !== "status") throw new Error("Usage: atlr repo status [--json]");
        const provider = core.repository.status();
        const snapshot = core.repository.snapshot();
        if (flagBoolean(parsed, "json")) asJson({ provider, snapshot });
        else process.stdout.write([
          `Provider: ${provider.provider}`,
          `Available: ${provider.available}`,
          `Repository: ${provider.repository}`,
          `Workspace: ${snapshot.workspaceId}`,
          ...(snapshot.vcs === "jj"
            ? [`Change: ${snapshot.changeId ?? "unknown"}`, `Commit: ${snapshot.headCommit}`, `Operation: ${snapshot.operationId ?? "unknown"}`]
            : [`Git commit: ${snapshot.headCommit}`]),
        ].join("\n") + "\n");
        return;
      }

      case "status": {
        const status = await core.status();
        if (flagBoolean(parsed, "json")) asJson(status);
        else {
          process.stdout.write([
            `Repository: ${status.repositoryRoot}`,
            `Mode: ${status.mode}`,
            `Plan: ${status.planPath} (${status.planExists ? "present" : "missing"})`,
            `Plan objective: ${status.planObjective ?? "none"}`,
            `Plan approval: ${status.approvedPlanHash === status.currentPlanHash ? "approved" : "not approved"}`,
            `Task provider: ${status.taskProvider.provider} (${status.taskProvider.available ? "available" : "unavailable"}, ${status.taskProvider.initialized ? "initialized" : "not initialized"})`,
            `Current task: ${status.currentTaskId ?? "none"}`,
            `Repository provider: ${status.snapshot.vcs}`,
            ...(status.snapshot.vcs === "jj"
              ? [
                  `Workspace: ${status.snapshot.workspaceId}`,
                  `Change: ${status.snapshot.changeId ?? "unknown"}`,
                  `Commit: ${status.snapshot.headCommit}`,
                  `Operation: ${status.snapshot.operationId ?? "unknown"}`,
                ]
              : [`Workspace: ${status.snapshot.workspaceId}`, `Git commit: ${status.snapshot.headCommit}`]),
            `Dirty generation: ${status.snapshot.dirtyGeneration}`,
            `Active grants: ${status.activePermissions.length}`,
          ].join("\n") + "\n");
        }
        return;
      }

      case "mode": {
        if (!(["investigate", "plan", "act"] as const).includes(subcommand as "investigate" | "plan" | "act")) {
          throw new Error("Mode must be investigate, plan, or act.");
        }
        core.setMode(subcommand as "investigate" | "plan" | "act");
        process.stdout.write(`Mode changed to ${subcommand}.\n`);
        return;
      }

      case "plan": {
        if (["create", "parse", "reconcile"].includes(subcommand ?? "")) {
          await handlePlan(core, subcommand, parsed);
          return;
        }
        const objective = [subcommand, ...rest].filter((value): value is string => value !== undefined).join(" ").trim();
        core.beginPlan(objective);
        process.stdout.write(`Plan mode active. Review ${core.config.planPath} with: atlr review\n`);
        return;
      }

      case "review": {
        await handlePlan(core, "review", parsed);
        return;
      }

      case "approve": {
        await handlePlan(core, "approve", parsed);
        return;
      }

      case "ready": {
        const tasks = await core.taskProvider.ready();
        if (flagBoolean(parsed, "json")) asJson(tasks);
        else for (const task of tasks) process.stdout.write(`${task.id}\tP${task.priority}\t${task.status}\t${task.title}\n`);
        return;
      }

      case "task": {
        await handleTasks(core, subcommand, rest, parsed);
        return;
      }

      case "permission": {
        await handlePermissions(core, subcommand, rest, parsed);
        return;
      }

      case "policy": {
        if (subcommand !== "command") throw new Error("Usage: atlr policy command \"COMMAND\"");
        const shellCommand = rest.join(" ");
        const classification = classifyShellCommand(shellCommand);
        const decision = core.evaluate({
          action: classification.action,
          actor: "user",
          repositorySnapshot: core.repository.snapshot(),
          command: [shellCommand],
          rationale: classification.rationale.join("; "),
        });
        asJson({ classification, decision });
        return;
      }

      case "state": {
        const state = await core.buildWorkingState(flagString(parsed, "task"));
        if (flagBoolean(parsed, "json")) asJson(state);
        else process.stdout.write(core.workingStateBuilder.toMarkdown(state));
        return;
      }

      case "code": {
        await handleCode(core, subcommand, rest, parsed);
        return;
      }

      case "changed": {
        const paths = core.repository.changedPaths();
        if (flagBoolean(parsed, "json")) asJson({ paths });
        else {
          process.stdout.write("Changed paths:\n");
          for (const path of paths) process.stdout.write(`- ${path}\n`);
        }
        return;
      }

      case "validate": {
        if (subcommand === "plan" || subcommand === "focused") {
          const snapshot = core.repository.snapshot();
          const changedPaths = core.repository.changedPaths();
          const plan = core.validation.planFocused(changedPaths, []);
          if (subcommand === "plan") {
            if (flagBoolean(parsed, "json")) asJson({ snapshot, changedPaths, validations: plan });
            else if (plan.length === 0) process.stdout.write("No focused validations matched the current changes.\n");
            else for (const item of plan) process.stdout.write(`${item.name}\t${item.reason}\n`);
            return;
          }
          const evidence = plan.map((item) => ({ selection: item, evidence: core.validation.run(item.name, snapshot) }));
          for (const item of evidence) core.ledger.append({ kind: "validation.completed", actor: "user", repositorySnapshot: snapshot, payload: { id: item.evidence.id, name: item.evidence.name, status: item.evidence.status, durationMs: item.evidence.durationMs, focused: true } });
          if (flagBoolean(parsed, "json")) asJson(evidence);
          else for (const item of evidence) process.stdout.write(`${item.evidence.name}: ${item.evidence.status} (${item.evidence.durationMs} ms)\n`);
          if (evidence.some((item) => item.evidence.status !== "passed")) process.exitCode = 4;
          return;
        }
        if (subcommand === "list") {
          const manifest = core.validation.manifest();
          if (flagBoolean(parsed, "json")) asJson(manifest);
          else for (const [name, definition] of Object.entries(manifest.validations)) process.stdout.write(`${name}\t${definition.command.join(" ")}\n`);
          return;
        }
        if (subcommand === "run") {
          const name = rest[0];
          if (!name) throw new Error("Usage: atlr validate run NAME");
          const snapshot = core.repository.snapshot();
          const evidence = core.validation.run(name, snapshot);
          core.ledger.append({ kind: "validation.completed", actor: "user", repositorySnapshot: snapshot, payload: { id: evidence.id, name, status: evidence.status, durationMs: evidence.durationMs } });
          if (flagBoolean(parsed, "json")) asJson(evidence);
          else process.stdout.write(`${name}: ${evidence.status} (${evidence.durationMs} ms)\n`);
          if (evidence.status !== "passed") process.exitCode = 4;
          return;
        }
        throw new Error("Usage: atlr validate <list|plan|focused|run NAME>");
      }

      case "evidence": {
        const evidenceName = flagString(parsed, "name");
        const evidence = core.validation.list({
          currentSnapshot: core.repository.snapshot(),
          ...(evidenceName === undefined ? {} : { name: evidenceName }),
        });
        if (flagBoolean(parsed, "json")) asJson(evidence);
        else for (const item of evidence) process.stdout.write(`${item.startedAt}\t${item.name}\t${item.status}\t${item.stale ? "stale" : "current"}\n`);
        return;
      }

      case "ledger": {
        if (subcommand !== "tail") throw new Error("Usage: atlr ledger tail [--limit N]");
        const limit = Number(flagString(parsed, "limit") ?? "25");
        const events = core.ledger.listEvents({ limit: Number.isFinite(limit) ? limit : 25 });
        if (flagBoolean(parsed, "json")) asJson(events);
        else {
          for (const event of events) {
            process.stdout.write(`${event.occurredAt}  ${event.kind}  ${JSON.stringify(event.payload)}\n`);
          }
        }
        return;
      }

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    core.close();
  }
}

async function handleCode(core: AtelierCore, subcommand: string | undefined, rest: string[], parsed: ParsedArgs): Promise<void> {
  const provider = flagString(parsed, "provider");
  if (subcommand === "providers") {
    const statuses = await core.code.providers(core.codeWorkspace());
    if (flagBoolean(parsed, "json")) asJson(statuses);
    else for (const status of statuses) process.stdout.write(`${status.identity.name}\t${status.available ? "available" : "unavailable"}\t${status.indexState}\t${status.capabilities.join(",")}\n`);
    return;
  }
  if (subcommand === "status" || subcommand === "doctor") {
    const status = await core.code.status(provider, core.codeWorkspace());
    if (flagBoolean(parsed, "json") || subcommand === "doctor") asJson({ workspace: core.codeWorkspace(), status });
    else process.stdout.write([
      `Provider: ${status.identity.name}`,
      `Available: ${status.available}`,
      `Healthy: ${status.healthy}`,
      `Index: ${status.indexState}`,
      `Capabilities: ${status.capabilities.join(", ") || "none"}`,
      ...(status.degraded === true ? ["Degraded: true"] : []),
      ...(status.warnings?.map((warning) => `Warning: ${warning}`) ?? []),
      ...(status.detail === undefined ? [] : [`Detail: ${status.detail}`]),
    ].join("\n") + "\n");
    return;
  }
  if (subcommand === "index") {
    const state = await core.code.ensureIndex(core.codeWorkspace(), provider);
    if (flagBoolean(parsed, "json")) asJson({ provider: provider ?? core.config.codeProvider, state });
    else process.stdout.write(`Code index state: ${state}\n`);
    return;
  }
  if (subcommand === "related") {
    const opaqueId = rest.join(" ").trim();
    if (!opaqueId) throw new Error("Usage: atlr code related REFERENCE [--repo ID] [--kind imports,calls,dependencies,references] [--depth N] [--limit N]");
    const workspace = core.codeWorkspace();
    const repositoryId = flagString(parsed, "repo") ?? workspace.repositories[0]?.id;
    if (!repositoryId) throw new Error("No repository is configured");
    const kinds = (flagString(parsed, "kind") ?? "references").split(",").filter(Boolean) as Array<"imports"|"calls"|"dependencies"|"references">;
    const relationships = await core.code.relationships({ workspace, reference: { provider: provider ?? core.config.codeProvider, opaqueId, repositoryId, path: flagString(parsed, "path") ?? opaqueId }, kinds, depth: Number(flagString(parsed, "depth") ?? "1"), limit: Number(flagString(parsed, "limit") ?? "20") }, provider);
    if (flagBoolean(parsed, "json")) asJson(relationships); else for (const item of relationships) process.stdout.write(`${item.kind}\t${item.target.repositoryId}:${item.target.path}\n`);
    return;
  }
  if (subcommand === "search" || subcommand === "symbols") {
    const query = rest.join(" ").trim();
    if (!query) throw new Error(`Usage: atlr code ${subcommand} QUERY [--provider NAME] [--repo ID] [--limit N] [--mode auto|semantic|hybrid|lexical] [--focus auto|source|tests|docs|all] [--hint IDENTIFIER,...]`);
    const repositoryIds = flagString(parsed, "repo")?.split(",").map((value) => value.trim()).filter(Boolean);
    const limit = Number(flagString(parsed, "limit") ?? "10");
    const mode = flagString(parsed, "mode") ?? "auto";
    if (!(["auto", "semantic", "hybrid", "lexical"] as const).includes(mode as "auto" | "semantic" | "hybrid" | "lexical")) throw new Error(`Invalid code search mode: ${mode}`);
    const focus = flagString(parsed, "focus") ?? "auto";
    if (!(["auto", "source", "tests", "docs", "all"] as const).includes(focus as "auto" | "source" | "tests" | "docs" | "all")) throw new Error(`Invalid code search focus: ${focus}`);
    const literalHints = flagString(parsed, "hint")?.split(",").map((value) => value.trim()).filter(Boolean);
    const results = subcommand === "search"
      ? await core.code.search({ workspace: core.codeWorkspace(), text: query, mode: mode as "auto" | "semantic" | "hybrid" | "lexical", focus: focus as "auto" | "source" | "tests" | "docs" | "all", ...(literalHints === undefined ? {} : { literalHints }), ...(provider === undefined ? {} : { provider }), ...(repositoryIds === undefined ? {} : { repositoryIds }), limit: Number.isFinite(limit) ? limit : 10 })
      : await core.code.symbols({ workspace: core.codeWorkspace(), text: query, ...(provider === undefined ? {} : { provider }), ...(repositoryIds === undefined ? {} : { repositoryIds }), limit: Number.isFinite(limit) ? limit : 10 });
    if (flagBoolean(parsed, "json")) asJson(results);
    else for (const hit of results) process.stdout.write(`${hit.repositoryName}:${hit.path}${hit.startLine === undefined ? "" : `:${hit.startLine}`}\t${hit.symbol ?? ""}\t${hit.preview ?? ""}\t[${hit.provenance.provider.name}/${hit.provenance.indexState}]\n`);
    return;
  }
  throw new Error("Usage: atlr code <providers|status|index|search|symbols|related|doctor>");
}

async function handlePlan(core: AtelierCore, subcommand: string | undefined, args: ParsedArgs): Promise<void> {
  switch (subcommand) {
    case "create": {
      const created = ensurePlanDocument(core.config.planPath);
      process.stdout.write(`${created ? "Created" : "Existing"} plan: ${core.config.planPath}\n`);
      return;
    }
    case "parse": {
      ensurePlanDocument(core.config.planPath);
      const plan = parsePlanFile(core.config.planPath);
      if (flagBoolean(args, "json")) asJson(plan);
      else {
        process.stdout.write(`${plan.title}\nHash: ${plan.hash}\nTasks: ${plan.tasks.length}\n`);
        for (const diagnostic of plan.diagnostics) {
          process.stdout.write(`${diagnostic.level.toUpperCase()} ${diagnostic.code}${diagnostic.line ? `:${diagnostic.line}` : ""}: ${diagnostic.message}\n`);
        }
      }
      if (plan.diagnostics.some((diagnostic) => diagnostic.level === "error")) process.exitCode = 2;
      return;
    }
    case "review": {
      ensurePlanDocument(core.config.planPath);
      const editor = resolveEditorCommand(core.config, true);
      const started = core.beginPlanReview({ editor });
      const result = runInteractiveProcess({
        command: editor.executable,
        args: [...editor.args, core.config.planPath],
        cwd: core.config.repositoryRoot,
      });
      if (result.exitCode !== 0 || result.signal !== undefined || result.error !== undefined) {
        core.cancelPlanReview(started.id, {
          status: result.signal === undefined ? "failed" : "interrupted",
          exitCode: result.exitCode,
          ...(result.signal === undefined ? {} : { signal: result.signal }),
          ...(result.error === undefined ? {} : { error: result.error }),
        });
        throw new Error(`Editor exited with code ${result.exitCode}${result.error ? `: ${result.error}` : ""}`);
      }
      const review = core.completePlanReview(started.id, { exitCode: result.exitCode });
      asJson(review);
      return;
    }
    case "approve": {
      const hash = core.approvePlan();
      process.stdout.write(`Approved plan revision ${hash}.\n`);
      return;
    }
    case "reconcile": {
      const reconciliation = await core.reconcilePlan(flagBoolean(args, "apply"));
      if (flagBoolean(args, "json")) asJson(reconciliation);
      else {
        process.stdout.write(`Plan: ${reconciliation.planHash}\nApplied: ${reconciliation.applied}\n`);
        for (const operation of reconciliation.operations) process.stdout.write(`- ${operation.kind}: ${operation.planTaskId}\n`);
        for (const conflict of reconciliation.conflicts) process.stdout.write(`CONFLICT: ${conflict}\n`);
      }
      if (reconciliation.conflicts.length > 0) process.exitCode = 3;
      return;
    }
    default:
      throw new Error("Usage: atlr plan [OBJECTIVE] | atlr plan <parse|reconcile>");
  }
}

async function handleTasks(core: AtelierCore, subcommand: string | undefined, rest: string[], args: ParsedArgs): Promise<void> {
  switch (subcommand) {
    case "ready": {
      const tasks = await core.taskProvider.ready();
      if (flagBoolean(args, "json")) asJson(tasks);
      else for (const task of tasks) process.stdout.write(`${task.id}\tP${task.priority}\t${task.status}\t${task.title}\n`);
      return;
    }
    case "show": {
      const id = rest[0];
      if (!id) throw new Error("Usage: atlr task show ID");
      const task = await core.taskProvider.get(id);
      if (task === undefined) throw new Error(`Task not found: ${id}`);
      if (flagBoolean(args, "json")) asJson(task);
      else process.stdout.write(`${task.id}: ${task.title}\n${task.description}\n`);
      return;
    }
    case "claim": {
      const id = rest[0];
      if (!id) throw new Error("Usage: atlr task claim ID");
      const task = await core.taskProvider.claim(id);
      core.ledger.setState("currentTaskId", task.id);
      core.ledger.append({ kind: "task.claimed", actor: "user", taskId: task.id, payload: { provider: core.taskProvider.name } });
      asJson(task);
      return;
    }
    case "close": {
      const id = rest[0];
      const reason = flagString(args, "reason");
      if (!id || !reason) throw new Error("Usage: atlr task close ID --reason TEXT");
      const task = await core.taskProvider.close(id, reason);
      core.ledger.append({ kind: "task.closed", actor: "user", taskId: task.id, payload: { reason } });
      asJson(task);
      return;
    }
    default:
      throw new Error("Usage: atlr task <show|claim|close>");
  }
}

async function handlePermissions(core: AtelierCore, subcommand: string | undefined, rest: string[], args: ParsedArgs): Promise<void> {
  switch (subcommand) {
    case "list": {
      const grants = core.ledger.listGrants();
      if (flagBoolean(args, "json")) asJson(grants);
      else for (const grant of grants) process.stdout.write(`${grant.id}\t${grant.permission}\t${grant.scope}\t${grant.reason}\n`);
      return;
    }
    case "grant": {
      const permission = rest[0];
      if (!permission || !PERMISSIONS.includes(permission as Permission)) {
        throw new Error(`Permission must be one of: ${PERMISSIONS.join(", ")}`);
      }
      const scope = flagString(args, "scope") ?? "session";
      if (!(["operation", "turn", "task", "session", "repository"] as const).includes(scope as never)) {
        throw new Error("Invalid grant scope.");
      }
      const paths = flagString(args, "path")?.split(",").map((path) => path.trim()).filter(Boolean);
      const taskId = flagString(args, "task");
      const grant = core.grant({
        permission: permission as Permission,
        scope: scope as "operation" | "turn" | "task" | "session" | "repository",
        reason: flagString(args, "reason") ?? "Explicit CLI grant",
        ...(taskId === undefined ? {} : { taskId }),
        ...(paths === undefined ? {} : { paths }),
      });
      asJson(grant);
      return;
    }
    case "revoke": {
      const id = rest[0];
      if (!id) throw new Error("Usage: atlr permission revoke ID");
      if (!core.revoke(id)) throw new Error(`Active grant not found: ${id}`);
      process.stdout.write(`Revoked ${id}.\n`);
      return;
    }
    default:
      throw new Error("Usage: atlr permission <list|grant|revoke>");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`atlr: ${message}\n`);
  process.exitCode = 1;
});
