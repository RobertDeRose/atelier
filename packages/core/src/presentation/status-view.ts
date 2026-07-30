import type { AtelierStatus } from "../core.ts";

export interface AtelierStatusView {
  workspace: { root: string; source: string };
  repository: { provider: string; identity: string; workspaceId: string; dirtyGeneration: number };
  workflow: { mode: string; checkpoint: string; plan: string; objective?: string; nextAction: string };
  task: { current: string; provider: string; providerState: string };
  execution: { grant: string; permissions: number; closure: string };
}

export function createStatusView(status: AtelierStatus): AtelierStatusView {
  const repositoryIdentity = status.snapshot.vcs === "jj"
    ? `jj ${(status.snapshot.changeId ?? "unknown").slice(0, 8)}`
    : status.snapshot.vcs === "git"
      ? `git ${status.snapshot.headCommit.slice(0, 8)}`
      : "no vcs";
  const plan = status.planStatus === "missing" ? "missing" : status.planStatus === "approved" ? "approved" : "not approved";
  const grant = status.activeExecutionGrant === undefined
    ? "none"
    : `${status.activeExecutionGrant.id} (${status.activeExecutionGrant.status}) for ${status.activeExecutionGrant.taskId}`;
  return {
    workspace: { root: status.workspaceRoot, source: status.workspaceSource },
    repository: { provider: status.snapshot.vcs, identity: repositoryIdentity, workspaceId: status.snapshot.workspaceId, dirtyGeneration: status.snapshot.dirtyGeneration },
    workflow: { mode: status.mode, checkpoint: status.workflowCheckpoint, plan, ...(status.planObjective ? { objective: status.planObjective } : {}), nextAction: status.nextAction },
    task: { current: status.currentTaskId ?? "none", provider: status.taskProvider.provider, providerState: !status.taskProvider.available ? "unavailable" : status.taskProvider.initialized ? "ready" : "not initialized" },
    execution: { grant, permissions: status.activePermissions.length, closure: status.closureStatus },
  };
}

export function statusViewLines(view: AtelierStatusView): string[] {
  return [
    `Workspace: ${view.workspace.root} (${view.workspace.source})`,
    `Repository: ${view.repository.identity} · workspace ${view.repository.workspaceId} · dirty generation ${view.repository.dirtyGeneration}`,
    `Mode: ${view.workflow.mode}`,
    `Workflow checkpoint: ${view.workflow.checkpoint}`,
    `Plan: ${view.workflow.plan}`,
    ...(view.workflow.objective ? [`Plan objective: ${view.workflow.objective}`] : []),
    `Task: ${view.task.current}`,
    `Task provider: ${view.task.provider} (${view.task.providerState})`,
    `Execution grant: ${view.execution.grant}`,
    `Active authority: ${view.execution.permissions}`,
    `Task closure: ${view.execution.closure}`,
    `Next action: ${view.workflow.nextAction}`,
  ];
}

export function statusViewText(view: AtelierStatusView): string {
  return `${statusViewLines(view).join("\n")}\n`;
}

export function statusViewSummary(view: AtelierStatusView): string {
  return `Atelier ${view.workflow.mode} · ${view.workflow.plan} · ${view.task.current === "none" ? "no task" : view.task.current} · ${view.repository.identity} · ${view.execution.closure}`;
}
