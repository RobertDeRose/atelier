#!/usr/bin/env -S node --experimental-strip-types
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadConfig, resolveEditorCommand } from "../../../packages/core/src/index.ts";

function commandAvailable(command: string, args: string[] = ["--version"]): { available: boolean; detail: string } {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, windowsHide: true });
  if (result.error !== undefined) return { available: false, detail: result.error.message };
  return {
    available: result.status === 0,
    detail: (result.stdout || result.stderr || `exit ${result.status}`).trim().split("\n")[0] ?? "",
  };
}

export function buildDoctorReport(root: string) {
  const config = loadConfig(root);
  const editor = (() => {
    try { return resolveEditorCommand(config, false); }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  })();
  const node = { version: process.version, supported: Number(process.versions.node.split(".")[0]) >= 24 };
  const git = commandAvailable("git");
  const jj = commandAvailable("jj");
  const pi = commandAvailable("pi");
  const beads = commandAvailable(config.beadsCommand);
  const project = {
    config: existsSync(config.projectConfigPath),
    plan: existsSync(config.planPath),
    validation: existsSync(config.validationPath),
  };
  const issues: string[] = [];
  if (!node.supported) issues.push(`Node ${node.version} is unsupported; Node 24 or newer is required.`);
  if (!pi.available) issues.push("Pi is unavailable; install Pi and ensure the pi executable is on PATH.");
  const repositoryReady = config.repositoryProvider === "git"
    ? git.available
    : config.repositoryProvider === "jj"
      ? jj.available
      : git.available || jj.available;
  if (!repositoryReady) {
    const provider = config.repositoryProvider === "auto" ? "Git or Jujutsu" : config.repositoryProvider === "git" ? "Git" : "Jujutsu";
    issues.push(`${provider} is unavailable; install it or select an available repository provider.`);
  }
  if (config.taskProvider === "beads" && !beads.available) {
    issues.push(`Beads is unavailable; install the configured '${config.beadsCommand}' command or choose another task provider.`);
  }
  if ("error" in editor) issues.push(`No editor is configured: ${editor.error}`);
  const initialized = project.config && project.plan && project.validation;
  if (!initialized) issues.push("Project files are missing; run `atlr launch` to initialize the workspace.");
  const status = issues.length === 0 ? "Operational" : "Degraded";

  return {
    observational: true,
    status,
    issues,
    node,
    git,
    jj,
    pi,
    beads,
    workspace: { root: config.workspaceRoot, source: config.workspaceSource, policy: "workspace_recoverability" },
    piTrust: "Pi /trust controls project-local Pi resources only.",
    editor,
    configuredProviders: { repository: config.repositoryProvider, tasks: config.taskProvider, code: config.codeProvider },
    security: { mode: config.securityMode, sandbox: config.sandboxBackend },
    project,
    projectConfigPath: config.projectConfigPath,
    planPath: config.planPath,
    validationPath: config.validationPath,
    runtimeDirectory: config.runtimeDirectory,
    repositoryRoot: root,
  };
}

export function formatDoctorReport(report: ReturnType<typeof buildDoctorReport>): string {
  const commandStatus = (name: string, status: { available: boolean; detail: string }): string => (
    `  ${name}: ${status.available ? `available${status.detail ? ` (${status.detail})` : ""}` : "not found"}`
  );
  const editorStatus = "error" in report.editor
    ? `not configured (${report.editor.error})`
    : `${report.editor.executable}${report.editor.args.length === 0 ? "" : ` ${report.editor.args.join(" ")}`} (${report.editor.source})`;
  const initialized = report.project.config && report.project.plan && report.project.validation;

  return [
    "Checking Atelier's health...",
    "",
    "Workspace",
    `  Root: ${report.workspace.root}`,
    `  Source: ${report.workspace.source === "startup_cwd" ? "current directory" : "explicit path"}`,
    `  Policy: ${report.workspace.policy}`,
    `  Project: ${initialized ? "ready" : "not initialized; launch will create the missing files"}`,
    `  Files: config ${report.project.config ? "ready" : "missing"}, plan ${report.project.plan ? "ready" : "missing"}, validation ${report.project.validation ? "ready" : "missing"}`,
    `  Runtime: ${existsSync(report.runtimeDirectory) ? "ready" : "will be created when needed"}`,
    "",
    "Tools",
    `  Node: ${report.node.version} (${report.node.supported ? "supported" : "requires Node 24 or newer"})`,
    commandStatus("Git", report.git),
    commandStatus("Jujutsu", report.jj),
    commandStatus("Pi", report.pi),
    commandStatus("Beads", report.beads),
    `  Editor: ${editorStatus}`,
    "",
    "Configured providers",
    `  Repository: ${report.configuredProviders.repository}`,
    `  Tasks: ${report.configuredProviders.tasks}`,
    `  Code insight: ${report.configuredProviders.code}`,
    `  Security: ${report.security.mode} (sandbox ${report.security.sandbox})`,
    "",
    `Status: ${report.status}`,
    ...(report.issues.length === 0 ? [] : ["Issues", ...report.issues.map((issue) => `  - ${issue}`)]),
  ].join("\n") + "\n";
}
