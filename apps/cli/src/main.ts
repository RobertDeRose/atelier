#!/usr/bin/env -S node --experimental-strip-types
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATELIER_VERSION,
  AtelierCore,
  approveWorkspaceRoot,
  classifyShellCommand,
  loadConfig,
  projectTrustStatus,
  revokeProjectTrust,
  revokeWorkspaceRoot,
  trustProject,
  resolveEditorCommand,
} from "../../../packages/core/src/index.ts";
import { flagBoolean, flagString, parseArgs } from "./arguments.ts";
import {
  asJson,
  explicitConfirmation,
  handleCode,
  handlePermissions,
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
  atlr [--root PATH] [--retrieval-session ID] <command>

Commands:
  launch [PI_ARGS...]              Launch Pi with the Atelier extension loaded
  trust [status|add|revoke]         Manage the external project trust decision
  trust workspace <add|revoke> PATH Approve additional multi-repository roots
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
  review                            Open the plan in the configured editor and record a ManualEdit
  approve [--approval ID]           Prepare, inspect, or explicitly apply an exact transaction
  execute [TASK_ID] [--yes]         Explicitly activate a later approved-plan task
  pause --reason TEXT               Pause active execution without revoking task capabilities
  resume                            Resume a paused execution without starting agent work
  cancel --reason TEXT              Revoke the current execution without closing its task
  ready [--json]                    Return provider-reported unblocked work
  task show ID [--json]             Read one provider task
  task start [ID] [--yes]           Explicitly activate a later approved-plan task
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
  --scope operation|task|repository
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
  const retrievalSessionId = flagString(parsed, "retrieval-session");
  const coreOpenOptions = retrievalSessionId === undefined ? {} : { retrievalSessionId };
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

  if (command === "trust") {
    const action = subcommand ?? "add";
    if (action === "status") {
      asJson(projectTrustStatus(root));
      return;
    }
    if (action === "workspace") {
      const workspaceAction = rest[0];
      const workspaceRoot = rest[1];
      if (!workspaceRoot || !["add", "revoke"].includes(workspaceAction ?? "")) {
        throw new Error("Usage: atlr trust workspace <add|revoke> PATH --yes");
      }
      if (!await explicitConfirmation(parsed, `${workspaceAction === "add" ? "Approve" : "Revoke"} workspace root ${resolve(workspaceRoot)}?`)) {
        process.stdout.write("Workspace trust change cancelled.\n");
        return;
      }
      const record = workspaceAction === "add"
        ? approveWorkspaceRoot(root, workspaceRoot)
        : revokeWorkspaceRoot(root, workspaceRoot);
      asJson(record);
      return;
    }
    if (!["add", "revoke"].includes(action)) throw new Error("Usage: atlr trust [status|add|revoke] [--yes]");
    if (!await explicitConfirmation(parsed, `${action === "add" ? "Trust" : "Revoke trust for"} project ${root}?`)) {
      process.stdout.write("Project trust change cancelled.\n");
      return;
    }
    if (action === "add") asJson({ trusted: true, record: trustProject(root), storePath: projectTrustStatus(root).storePath });
    else asJson({ trusted: false, revoked: revokeProjectTrust(root), root, storePath: projectTrustStatus(root).storePath });
    return;
  }

  if (command === "doctor") {
    const trust = projectTrustStatus(root);
    const config = loadConfig(root, { projectTrusted: trust.trusted });
    const editor = trust.trusted ? (() => {
      try { return resolveEditorCommand(config, false); }
      catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
    })() : { disabled: true, reason: "Project is not trusted; repository editor configuration was not loaded." };
    asJson({
      observational: true,
      node: { version: process.version, supported: Number(process.versions.node.split(".")[0]) >= 24 },
      git: commandAvailable("git"),
      jj: commandAvailable("jj"),
      pi: commandAvailable("pi"),
      trust,
      editor,
      configuredProviders: trust.trusted ? {
        repository: config.repositoryProvider,
        tasks: config.taskProvider,
        code: config.codeProvider,
      } : { repository: "disabled", tasks: "disabled", code: "disabled" },
      projectConfigPath: config.projectConfigPath,
      runtimeDirectory: config.runtimeDirectory,
      repositoryRoot: root,
    });
    return;
  }

  const core = AtelierCore.open(root, coreOpenOptions);
  try {
    switch (command) {
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
            `Next action: ${status.nextAction}`,
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

      case "permission": {
        await handlePermissions(core, subcommand, rest, parsed);
        return;
      }

      case "policy": {
        if (subcommand !== "command") throw new Error("Usage: atlr policy command \"COMMAND\"");
        const shellCommand = rest.join(" ");
        const classification = classifyShellCommand(shellCommand);
        const decision = core.evaluate({
          // The classifier is explanatory only for arbitrary shell. Policy
          // always treats the command as unconfined executable code.
          action: "command.execute",
          risk: classification.risk,
          actor: "user",
          repositorySnapshot: core.repository.snapshot(),
          command: [shellCommand],
          boundary: "unconfined",
          rationale: `${classification.rationale.join("; ")} Generic shell is always authorized as unconfined command execution.`,
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
