import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AtelierCore, StandaloneTaskExecutionOptions } from "../../../packages/core/src/index.ts";
import { confirmApprovalDialog } from "./approval-dialog.ts";
import { appendAtelierReport } from "./report-presentation.ts";
import { readyTasksMarkdown } from "./command-reports.ts";

export function parseStandaloneTaskCommand(raw: string): StandaloneTaskExecutionOptions | undefined {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  let taskId: string | undefined;
  let taskFlag = false;
  let writeFlag: string | undefined;
  let validationFlag: string | undefined;
  let standalone = false;
  let allowDependencyChanges = false;
  let allowFullSuite = false;
  let allowLocalChange = true;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--standalone") {
      standalone = true;
      continue;
    }
    if (token === "--task") {
      taskFlag = true;
      taskId = tokens[++index];
      continue;
    }
    if (token === "--write") {
      writeFlag = tokens[++index];
      continue;
    }
    if (token === "--validation" || token === "--validations") {
      validationFlag = tokens[++index];
      continue;
    }
    if (token === "--dependencies") {
      allowDependencyChanges = true;
      continue;
    }
    if (token === "--full-suite") {
      allowFullSuite = true;
      continue;
    }
    if (token === "--no-local-change") {
      allowLocalChange = false;
      continue;
    }
    if (token.startsWith("--")) throw new Error(`Unknown standalone task option: ${token}`);
    if (taskId === undefined) taskId = token;
    else throw new Error("Standalone task activation accepts only one task id.");
  }
  if (!standalone && !taskFlag && writeFlag === undefined) return undefined;
  const resolvedTaskId = taskId?.trim();
  const writePaths = writeFlag?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (!resolvedTaskId) {
    throw new Error("Usage: /approve --task TASK_ID [--write PATH[,PATH]] [--validation NAME[,NAME]] [--dependencies] [--full-suite]");
  }
  const validations = validationFlag?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  return {
    taskId: resolvedTaskId,
    writePaths,
    ...(validations.length === 0 ? {} : { validations }),
    ...(allowDependencyChanges ? { allowDependencyChanges } : {}),
    ...(allowFullSuite ? { allowFullSuite } : {}),
    ...(allowLocalChange ? {} : { allowLocalChange }),
  };
}

export async function approveStandaloneTask(
  ctx: ExtensionCommandContext,
  core: AtelierCore,
  options: StandaloneTaskExecutionOptions,
  refreshStatus: (ctx: ExtensionCommandContext, core: AtelierCore) => Promise<void>,
): Promise<void> {
  await ctx.waitForIdle();
  const status = await core.taskProvider.status();
  if (!status.available || !status.initialized) {
    ctx.ui.notify(status.reason ?? `${status.provider} is unavailable or uninitialized.`, "error");
    return;
  }
  const task = await core.taskProvider.get(options.taskId);
  if (task === undefined) {
    ctx.ui.notify(`Task not found: ${options.taskId}`, "error");
    return;
  }
  const summary = [
    `Standalone task: ${task.id} — ${task.title}`,
    `Writes: ${options.writePaths?.join(", ") || ". (all application-source paths; metadata and dependencies excluded by default)"}`,
    `Validations: ${options.validations?.join(", ") || "none"}`,
    `Dependency changes: ${options.allowDependencyChanges === true ? "allowed" : "excluded"}`,
    `Full suite: ${options.allowFullSuite === true ? "allowed" : "excluded"}`,
    `Local change: ${options.allowLocalChange === false ? "not required" : "required"}`,
    "No plan file will be created, changed, or reconciled.",
  ];
  const confirmed = await confirmApprovalDialog(ctx, {
    title: "Approve standalone task execution",
    lines: summary,
    approveLabel: "Activate task",
  });
  if (!confirmed) {
    ctx.ui.notify("Standalone task activation was not approved.", "warning");
    return;
  }
  try {
    const transition = await core.execution.startStandaloneTask(options, true);
    if (transition === undefined) throw new Error("Standalone task activation was not confirmed.");
    ctx.ui.notify(`Activated standalone task ${transition.task.id} with execution grant ${transition.executionGrant.id}.`, "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  } finally {
    await refreshStatus(ctx, core);
  }
}

export function registerStandaloneTaskCommands(
  pi: ExtensionAPI,
  getCore: (ctx: ExtensionContext) => AtelierCore,
  refreshStatus: (ctx: ExtensionContext, core: AtelierCore) => Promise<void>,
): void {
  pi.registerCommand("task-start", {
    description: "Activate one existing task without a plan using repository-wide source scope by default",
    handler: async (args, ctx) => {
      const standalone = parseStandaloneTaskCommand(`--standalone ${args}`);
      if (standalone === undefined) throw new Error("Usage: /task-start TASK_ID [--write PATH[,PATH]] [--validation NAME[,NAME]]");
      await approveStandaloneTask(ctx, getCore(ctx), standalone, refreshStatus);
    },
  });

  pi.registerCommand("ready", {
    description: "Show or select provider-reported ready work",
    handler: async (args, ctx) => {
      const core = getCore(ctx);
      const ready = (await core.taskProvider.ready())
        .filter((task) => ["bug", "feature", "task", "chore", "spike"].includes(task.type));
      if (ready.length === 0) {
        appendAtelierReport(pi, ctx, "Ready tasks", readyTasksMarkdown([]), "none ready");
        return;
      }
      const requested = args.trim();
      let selected = requested ? ready.find((task) => task.id === requested) : undefined;
      if (selected === undefined && ctx.hasUI) {
        const labels = ready.map((task) => `${task.id} · P${task.priority} · ${task.title}`);
        const choice = await ctx.ui.select("Select Atelier task", labels);
        const index = choice === undefined ? -1 : labels.indexOf(choice);
        selected = index < 0 ? undefined : ready[index];
      }
      if (selected === undefined) {
        appendAtelierReport(pi, ctx, "Ready tasks", readyTasksMarkdown(ready), `${ready.length} ready`);
        return;
      }
      core.ledger.setState("currentTaskId", selected.id);
      core.ledger.append({
        kind: "task.selected",
        actor: "user",
        taskId: selected.id,
        payload: { provider: core.taskProvider.name },
      });
      ctx.ui.notify(`Selected ${selected.id}: ${selected.title}`, "info");
      await refreshStatus(ctx, core);
    },
  });
}
