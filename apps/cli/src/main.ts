#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATELIER_VERSION,
  AtelierCore,
  classifyShellCommand,
  loadConfig,
  resolveEditorCommand,
  createStatusView,
  statusViewText,
  resolveSandboxBackend,
  runInteractiveProcess,
  updatePlanTaskScopeFile,
  AtelierServiceClient,
  AtelierServiceServer,
} from "../../../packages/core/src/index.ts";
import { flagBoolean, flagString, parseArgs } from "./arguments.ts";
import {
  asJson,
  explicitConfirmation,
  handleCode,
  handlePlan,
  handleTasks,
  handleTaskStart,
} from "./command-handlers.ts";

function commandAvailable(command: string, args: string[] = ["--version"]): { available: boolean; detail: string } {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, windowsHide: true });
  if (result.error !== undefined) return { available: false, detail: result.error.message };
  return {
    available: result.status === 0,
    detail: (result.stdout || result.stderr || `exit ${result.status}`).trim().split("\n")[0] ?? "",
  };
}

function printHelp(): void {
  process.stdout.write(`Atelier ${ATELIER_VERSION}

Usage:
  atlr [--root PATH] [--workspace PATH] [--retrieval-session ID] <command>

Commands:
  launch [PI_ARGS...]              Launch Pi with the Atelier extension loaded
  init [--beads] [--stealth]       Initialize project configuration and a plan document
  repo status [--json]             Show the selected repository provider and identity
  repo review-diff [--json]        Record review of the exact current task diff
  repo commit --message TEXT       Create the required local commit/change
  doctor                            Inspect configuration without creating state or starting providers
  status [--json]                   Show workflow, plan, task-provider, and repository state
  mode <investigate|plan|act>       Change the guarded workflow mode
  plan [OBJECTIVE]                  Enter plan mode and create the plan document if missing
  plan parse [--json]               Parse and validate the plan
  plan reconcile [--json]           Preview task-provider reconciliation
  plan prepare [--json]             Prepare an exact execution approval transaction
  plan scope TASK --write PATHS      Canonically update task execution scope
  review                            Open the plan in the configured editor and record a ManualEdit
  approve [--approval ID]           Prepare, inspect, or explicitly apply an exact transaction
  execute [TASK_ID] [--yes]         Explicitly activate a later approved-plan task
  resume-task [TASK_ID] [--yes]     Resume a cancelled approved task
  pause --reason TEXT               Pause active execution without revoking task constraints
  resume                            Resume a paused execution without starting agent work
  cancel --reason TEXT              Revoke the current execution without closing its task
  ready [--json]                    Return provider-reported unblocked work
  task show ID [--json]             Read one provider task
  task start [ID] [--yes]           Explicitly activate a later approved-plan task
  task close ID --reason TEXT       Close a task with evidence
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
  data inspect|prune|delete|export  Manage redacted retained evidence
  sandbox status                    Show shell sandbox availability
  workspace status                  Show configured repository ownership and revisions
  open PATH[:LINE]                  Open a path in the configured editor
  files [--json]                    List tracked repository files
  tree [--json]                     Show a bounded project tree
  serve [--socket PATH]             Run the local Atelier Core service
  service <status|state|stop>       Query a running local Core service
  recovery list [--json]            List automatic recovery checkpoints
  recovery restore ID               Restore one checkpoint

Code search options:
  --mode auto|semantic|hybrid|lexical
  --focus auto|source|tests|docs|all
  --hint IDENTIFIER[,IDENTIFIER...] Exact identifiers for bounded lexical augmentation

Atelier owns the Code provider contract, provenance, and Working State integration. External providers own code indexing.
`);
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  const parsed = parseArgs(raw);
  const requestedRoot = resolve(flagString(parsed, "root") ?? process.cwd());
  const root = existsSync(requestedRoot) ? realpathSync(requestedRoot) : requestedRoot;
  const retrievalSessionId = flagString(parsed, "retrieval-session");
  const workspaceRoot = flagString(parsed, "workspace");
  const coreOpenOptions = { ...(retrievalSessionId === undefined ? {} : { retrievalSessionId }), ...(workspaceRoot === undefined ? {} : { workspaceRoot: resolve(workspaceRoot) }) };
  const [command, subcommand, ...rest] = parsed.positionals;

  if (flagBoolean(parsed, "version")) {
    process.stdout.write(`${ATELIER_VERSION}\n`);
    return;
  }
  if (command === undefined || command === "help" || flagBoolean(parsed, "help")) {
    printHelp();
    return;
  }

  if (command === "launch") {
    const commandIndex = raw.indexOf("launch");
    const piArgs = commandIndex === -1 ? [] : raw.slice(commandIndex + 1);
    const builtExtension = fileURLToPath(new URL("../../pi-extension/src/index.js", import.meta.url));
    const sourceExtension = fileURLToPath(new URL("../../pi-extension/src/index.ts", import.meta.url));
    const extensionPath = existsSync(builtExtension) ? builtExtension : sourceExtension;
    const result = spawnSync("pi", ["--extension", extensionPath, ...piArgs], {
      cwd: root,
      env: { ...process.env, ATELIER_ROOT: root, ...(workspaceRoot === undefined ? {} : { ATELIER_WORKSPACE_ROOT: resolve(workspaceRoot) }) },
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


  if (command === "service") {
    const config = loadConfig(root);
    const socketPath = resolve(flagString(parsed, "socket") ?? resolve(config.runtimeDirectory, "atelier.sock"));
    const client = new AtelierServiceClient(socketPath);
    if (subcommand === "status" || subcommand === undefined) asJson(await client.request("status"));
    else if (subcommand === "state") asJson(await client.request("state"));
    else if (subcommand === "stop") asJson(await client.request("shutdown"));
    else throw new Error("Usage: atlr service <status|state|stop> [--socket PATH]");
    return;
  }

  if (command === "doctor") {
    const config = loadConfig(root);
    const editor = (() => {
      try { return resolveEditorCommand(config, false); }
      catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
    })();
    asJson({
      observational: true,
      node: { version: process.version, supported: Number(process.versions.node.split(".")[0]) >= 24 },
      git: commandAvailable("git"), jj: commandAvailable("jj"), pi: commandAvailable("pi"), beads: commandAvailable(config.beadsCommand),
      workspace: { root: config.workspaceRoot, source: config.workspaceSource, policy: "workspace_recoverability" },
      piTrust: "Pi /trust controls project-local Pi resources only.",
      editor,
      configuredProviders: { repository: config.repositoryProvider, tasks: config.taskProvider, code: config.codeProvider },
      projectConfigPath: config.projectConfigPath, runtimeDirectory: config.runtimeDirectory, repositoryRoot: root,
    });
    return;
  }

  const core = AtelierCore.open(root, coreOpenOptions);
  try {
    switch (command) {
      case "serve": {
        const socketPath = resolve(flagString(parsed, "socket") ?? resolve(core.config.runtimeDirectory, "atelier.sock"));
        const service = new AtelierServiceServer({ core, socketPath });
        await service.start();
        process.stdout.write(`Atelier service listening on ${socketPath}\n`);
        await new Promise<void>((resolveStop) => {
          const stop = (): void => resolveStop();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        await service.stop();
        return;
      }
      case "init": {
        const initialized = core.initialize({ createPlan: true });
        let beads: unknown;
        if (flagBoolean(parsed, "beads")) {
          const before = await core.taskProvider.status();
          if (!before.initialized) {
            await core.taskProvider.initialize({ stealth: flagBoolean(parsed, "stealth"), quiet: true });
            core.ledger.append({
              kind: "task_provider.initialized",
              actor: "user",
              payload: { provider: core.taskProvider.name, stealth: flagBoolean(parsed, "stealth") },
            });
          } else {
            core.ledger.append({
              kind: "task_provider.initialization_skipped",
              actor: "user",
              payload: { provider: core.taskProvider.name, reason: "already initialized" },
            });
          }
          beads = await core.taskProvider.status();
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
        if (subcommand === "status") {
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
        if (subcommand === "review-diff") {
          const preview = core.previewFinalDiff();
          if (!flagBoolean(parsed, "json")) {
            process.stdout.write(`${preview.diff.trimEnd()}\n\n`);
          }
          const review = core.reviewFinalDiff(preview.diffHash);
          if (flagBoolean(parsed, "json")) asJson({ preview, review });
          else process.stdout.write(`Reviewed ${review.changedPaths.length} changed path(s); diff ${review.diffHash}.\n`);
          return;
        }
        if (subcommand === "commit") {
          const message = flagString(parsed, "message") ?? rest.join(" ").trim();
          if (!message) throw new Error("Usage: atlr repo commit --message TEXT");
          const result = core.commitActiveTask(message);
          if (flagBoolean(parsed, "json")) asJson(result);
          else process.stdout.write(`Created local ${result.snapshot.vcs === "jj" ? "change" : "commit"}: ${result.message}\n`);
          return;
        }
        throw new Error("Usage: atlr repo <status|review-diff|commit>");
      }

      case "status": {
        const status = await core.status();
        const view = createStatusView(status);
        if (flagBoolean(parsed, "json")) asJson(view);
        else process.stdout.write(statusViewText(view));
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
        if (subcommand === "scope") {
          const taskId = rest[0];
          const writePaths = (flagString(parsed, "write") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
          const validations = (flagString(parsed, "validation") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
          if (!taskId || writePaths.length === 0) {
            throw new Error("Usage: atlr plan scope TASK_ID --write PATH[,PATH] [--validation NAME[,NAME]] [--dependencies] [--full-suite] [--no-local-change]");
          }
          const unknown = validations.filter((name) => core.validation.definition(name) === undefined);
          if (unknown.length > 0) throw new Error(`Unknown validation(s): ${unknown.join(", ")}`);
          const execution = updatePlanTaskScopeFile(core.config.planPath, {
            taskId,
            execution: {
              writePaths,
              allowDependencyChanges: flagBoolean(parsed, "dependencies"),
              validations,
              allowFullSuite: flagBoolean(parsed, "full-suite"),
              allowLocalChange: !flagBoolean(parsed, "no-local-change"),
            },
          });
          if (flagBoolean(parsed, "json")) asJson({ taskId, execution, planPath: core.config.planPath });
          else process.stdout.write(`Updated ${taskId} execution scope in ${core.config.planPath}.\n`);
          return;
        }
        if (["create", "parse", "reconcile", "prepare"].includes(subcommand ?? "")) {
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


      case "resume-task": {
        const taskId = subcommand;
        const confirmed = await explicitConfirmation(parsed, `Resume cancelled task ${taskId ?? "from the last approved execution"}?`);
        if (!confirmed) { process.stdout.write("Task resume cancelled.\n"); return; }
        const transition = await core.execution.resumeCancelledTask(true, taskId);
        if (transition === undefined) throw new Error("Task resume was not confirmed.");
        if (flagBoolean(parsed, "json")) asJson(transition);
        else process.stdout.write(`Resumed ${transition.task.id} with execution grant ${transition.executionGrant.id}.\n`);
        return;
      }

      case "execute": {
        await handleTaskStart(core, subcommand, parsed);
        return;
      }

      case "pause": {
        const reason = flagString(parsed, "reason") ?? (rest.join(" ").trim() || "User paused execution through the CLI.");
        const paused = core.execution.pause(reason);
        if (paused === undefined) throw new Error("No active execution exists to pause.");
        if (flagBoolean(parsed, "json")) asJson({ paused: true, executionGrant: paused, reason });
        else process.stdout.write(`Paused execution ${paused.id}; task ${paused.taskId} remains active.\n`);
        return;
      }

      case "resume": {
        const resumed = core.execution.resumePaused();
        if (resumed === undefined) throw new Error("No active execution exists to resume.");
        if (flagBoolean(parsed, "json")) asJson({ resumed: true, executionGrant: resumed });
        else process.stdout.write(`Resumed execution ${resumed.id}; task ${resumed.taskId} remains active.\n`);
        return;
      }

      case "cancel": {
        const reason = flagString(parsed, "reason");
        if (!reason) throw new Error("Usage: atlr cancel --reason TEXT [--json]");
        const executionGrant = core.execution.cancel(reason);
        if (executionGrant === undefined) throw new Error("No active execution exists to cancel.");
        if (flagBoolean(parsed, "json")) asJson({ executionGrant, nextAction: await core.nextAction() });
        else process.stdout.write(`Cancelled execution ${executionGrant.id}. Task ${executionGrant.taskId} remains open.\n`);
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


      case "policy": {
        if (subcommand !== "command") throw new Error("Usage: atlr policy command \"COMMAND\"");
        const shellCommand = rest.join(" ");
        const classification = classifyShellCommand(shellCommand);
        const effects = [{ kind: "execute" as const, description: shellCommand }];
        const decision = core.evaluateWorkspaceEffects(effects);
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
          const changedPaths = core.repository.changedPaths()
            .filter((path) => path !== ".atelier" && !path.startsWith(".atelier/"));
          if (subcommand === "plan") {
            const selection = core.selectFocusedValidation();
            if (flagBoolean(parsed, "json")) asJson({ snapshot, changedPaths, selection });
            else if (selection.noMatch) process.stdout.write(`Focused selection ${selection.id}: no configured validations matched the current changes.\n`);
            else {
              process.stdout.write(`Focused selection ${selection.id}:\n`);
              for (const item of selection.selected) process.stdout.write(`${item.name}\t${item.reason}${item.required ? "\trequired" : ""}\n`);
            }
            return;
          }
          const selection = core.selectFocusedValidation();
          const evidence = [];
          for (const item of selection.selected) {
            evidence.push({ selection: item, evidence: await core.runValidation(item.name, { selectionId: selection.id }) });
          }
          if (flagBoolean(parsed, "json")) asJson({ selection, evidence });
          else if (selection.noMatch) process.stdout.write("No focused validations matched the current changes.\n");
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
          const evidence = await core.runValidation(name);
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
          currentChangedPaths: core.repository.changedPaths()
            .filter((path) => path !== ".atelier" && !path.startsWith(".atelier/")),
          ...(evidenceName === undefined ? {} : { name: evidenceName }),
        });
        if (flagBoolean(parsed, "json")) asJson(evidence);
        else for (const item of evidence) process.stdout.write(`${item.startedAt}\t${item.name}\t${item.status}\t${item.stale ? "stale" : "current"}\n`);
        return;
      }

      case "recovery": {
        if (subcommand === "list" || subcommand === undefined) {
          const checkpoints = core.recovery.list();
          if (flagBoolean(parsed, "json")) asJson(checkpoints);
          else for (const checkpoint of checkpoints) process.stdout.write(`${checkpoint.id}\t${checkpoint.createdAt}\t${checkpoint.paths.length} path(s)\n`);
          return;
        }
        if (subcommand === "restore") {
          const id = rest[0];
          if (!id) throw new Error("Usage: atlr recovery restore ID");
          const paths = core.restoreCheckpoint(id);
          if (flagBoolean(parsed, "json")) asJson({ id, paths });
          else process.stdout.write(`Restored ${paths.length} path(s) from ${id}.\n`);
          return;
        }
        throw new Error("Usage: atlr recovery <list|restore ID>");
      }





      case "files": {
        const files = core.repository.listFiles();
        if (flagBoolean(parsed, "json")) asJson(files); else process.stdout.write(`${files.join("\n")}\n`);
        return;
      }
      case "tree": {
        const files = core.repository.listFiles().slice(0, 250);
        const lines = files.map((path) => `${"  ".repeat(path.split("/").length - 1)}${path.split("/").at(-1)}`);
        if (flagBoolean(parsed, "json")) asJson({ files }); else process.stdout.write(`${lines.join("\n")}\n`);
        return;
      }
      case "open": {
        const value = [subcommand, ...rest].filter(Boolean).join(" ").trim();
        if (!value) throw new Error("Usage: atlr open PATH[:LINE]");
        const match = /^(.*?):(\d+)$/.exec(value);
        const path = resolve(root, match?.[1] ?? value);
        const editor = resolveEditorCommand(core.config, false);
        const executable = editor.executable.split(/[\\/]/).at(-1) ?? editor.executable;
        const args = match?.[2] !== undefined && ["hx", "helix"].includes(executable) ? [...editor.args, `${path}:${match[2]}`] : [...editor.args, path];
        const result = await runInteractiveProcess({ command: editor.executable, args, cwd: core.config.repositoryRoot });
        if (result.exitCode !== 0) throw new Error(result.error ?? `Editor exited ${result.exitCode}`);
        return;
      }

      case "workspace": {
        if (subcommand !== "status" && subcommand !== undefined) throw new Error("Usage: atlr workspace status");
        const workspace = core.codeWorkspace();
        asJson({ id: workspace.id, name: workspace.name, roots: workspace.roots, repositories: workspace.repositories.map((repository) => ({ id: repository.id, name: repository.name, root: repository.root, role: repository.role, snapshot: repository.snapshot })) });
        return;
      }

      case "sandbox": {
        if (subcommand !== "status" && subcommand !== undefined) throw new Error("Usage: atlr sandbox status");
        asJson(resolveSandboxBackend(core.config.sandboxBackend));
        return;
      }

      case "data": {
        if (subcommand === "inspect" || subcommand === undefined) {
          asJson(core.ledger.dataSummary());
          return;
        }
        if (subcommand === "prune") {
          const days = Number(flagString(parsed, "days") ?? "30");
          const keep = Number(flagString(parsed, "keep") ?? "1000");
          asJson(core.ledger.pruneData({ before: new Date(Date.now() - Math.max(0, days) * 86_400_000).toISOString(), keep }));
          return;
        }
        if (subcommand === "delete") {
          if (!flagBoolean(parsed, "yes")) throw new Error("atlr data delete requires --yes");
          asJson(core.ledger.deleteHistoricalData());
          return;
        }
        if (subcommand === "export") {
          asJson(core.ledger.exportData());
          return;
        }
        throw new Error("Usage: atlr data <inspect|prune [--days N --keep N]|delete --yes|export>");
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
    await core.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`atlr: ${message}\n`);
  process.exitCode = 1;
});
