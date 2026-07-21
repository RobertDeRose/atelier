import type { ActionKind, Permission } from "../domain/types.ts";
import { splitCommandLine } from "../util/command-line.ts";

export interface CommandClassification {
  command: string;
  action: ActionKind;
  requiredPermission?: Permission;
  confidence: "high" | "medium" | "low";
  mutating: boolean;
  longRunning: boolean;
  network: boolean;
  rationale: string[];
}

const READ_ONLY_COMMANDS = new Set([
  "basename",
  "cat",
  "cut",
  "dirname",
  "du",
  "env",
  "fd",
  "find",
  "grep",
  "head",
  "jq",
  "ls",
  "pwd",
  "rg",
  "sed",
  "sort",
  "stat",
  "tail",
  "tree",
  "uniq",
  "wc",
  "which",
  "whereis",
]);

const MUTATING_EXECUTABLES = new Set([
  "chmod",
  "chown",
  "cp",
  "dd",
  "install",
  "ln",
  "mkdir",
  "mktemp",
  "mv",
  "patch",
  "rm",
  "rmdir",
  "tee",
  "touch",
  "truncate",
]);

const NETWORK_EXECUTABLES = new Set([
  "curl",
  "ftp",
  "git",
  "gh",
  "http",
  "nc",
  "ncat",
  "npm",
  "npx",
  "pnpm",
  "scp",
  "ssh",
  "wget",
  "yarn",
]);

const LONG_RUNNING_EXECUTABLES = new Set([
  "cargo",
  "docker",
  "go",
  "gradle",
  "gradlew",
  "make",
  "mvn",
  "npm",
  "aube",
  "aubr",
  "aubx",
  "pnpm",
  "pytest",
  "tox",
  "yarn",
]);

function containsRedirection(command: string): boolean {
  let single = false;
  let double = false;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && !single) {
      escaped = true;
      continue;
    }
    if (character === "'" && !double) {
      single = !single;
      continue;
    }
    if (character === '"' && !single) {
      double = !double;
      continue;
    }
    if (!single && !double && character === ">") return true;
  }
  return false;
}

function classifyGit(args: string[], rationale: string[]): CommandClassification {
  const subcommand = args[1] ?? "";
  const readOnly = new Set([
    "branch",
    "diff",
    "grep",
    "log",
    "rev-parse",
    "show",
    "status",
    "tag",
  ]);
  const network = new Set(["fetch", "ls-remote", "pull", "push", "remote"]);
  if (readOnly.has(subcommand)) {
    if (subcommand === "branch" && args.some((arg) => ["-c", "-C", "-d", "-D", "--delete", "--move"].includes(arg))) {
      rationale.push("git branch option mutates repository references");
      return mutation("repository.change.create", "repository.change.create", rationale, false, false, args.join(" "));
    }
    rationale.push(`git ${subcommand} is treated as read-only`);
    return readonly(args.join(" "), rationale);
  }
  if (network.has(subcommand)) {
    rationale.push(`git ${subcommand} may access the network or mutate repository state`);
    const action: ActionKind = subcommand === "push" ? "repository.publish" : "network.access";
    const permission: Permission = subcommand === "push" ? "repository.publish" : "network.access";
    return mutation(action, permission, rationale, false, true, args.join(" "));
  }
  rationale.push(`git ${subcommand || "command"} can mutate repository state`);
  return mutation("repository.change.create", "repository.change.create", rationale, false, false, args.join(" "));
}

function classifyJj(args: string[], rationale: string[]): CommandClassification {
  const subcommand = args[1] ?? "";
  if (["diff", "file", "log", "op", "show", "status", "workspace"].includes(subcommand)) {
    if (subcommand === "op" && !["", "log", "show"].includes(args[2] ?? "")) {
      rationale.push("jj op subcommand can restore or mutate repository state");
      return mutation("repository.change.create", "repository.change.create", rationale, false, false, args.join(" "));
    }
    if (subcommand === "workspace" && !["", "list", "root"].includes(args[2] ?? "")) {
      rationale.push("jj workspace subcommand can create or remove workspaces");
      return mutation("repository.workspace.create", "repository.workspace.create", rationale, false, false, args.join(" "));
    }
    rationale.push(`jj ${subcommand} is treated as read-only`);
    return readonly(args.join(" "), rationale);
  }
  if (subcommand === "git" && args[2] === "push") {
    rationale.push("jj git push publishes repository state");
    return mutation("repository.publish", "repository.publish", rationale, false, true, args.join(" "));
  }
  rationale.push(`jj ${subcommand || "command"} can mutate repository state`);
  return mutation("repository.change.create", "repository.change.create", rationale, false, false, args.join(" "));
}

function classifyBeads(args: string[], rationale: string[]): CommandClassification {
  const subcommand = args[1] ?? "";
  if (["blocked", "children", "dep", "graph", "info", "list", "prime", "ready", "show", "status", "version", "where"].includes(subcommand)) {
    if (subcommand === "dep" && !["", "cycles", "list", "tree"].includes(args[2] ?? "")) {
      rationale.push("bd dep mutation changes task relationships");
      return mutation("task.link", "task.link", rationale, false, false, args.join(" "));
    }
    rationale.push(`bd ${subcommand} is treated as read-only`);
    return readonly(args.join(" "), rationale);
  }
  if (subcommand === "create" || subcommand === "init") {
    rationale.push(`bd ${subcommand} creates durable task state`);
    return mutation("task.create", "task.create", rationale, false, false, args.join(" "));
  }
  if (["close", "defer", "supersede"].includes(subcommand)) {
    rationale.push(`bd ${subcommand} changes task lifecycle state`);
    return mutation("task.close", "task.close", rationale, false, false, args.join(" "));
  }
  rationale.push(`bd ${subcommand || "command"} can mutate task state`);
  return mutation("task.update", "task.update", rationale, false, false, args.join(" "));
}

function classifyPackageManager(executable: string, args: string[], rationale: string[]): CommandClassification {
  const subcommand = args[1] ?? "";
  if (["install", "add", "remove", "uninstall", "update", "upgrade", "link", "unlink", "dedupe"].includes(subcommand)) {
    rationale.push(`${executable} ${subcommand} changes dependencies or lockfiles`);
    return mutation("dependency.modify", "dependency.modify", rationale, true, true, args.join(" "));
  }
  if (["test", "check", "lint", "run", "exec", "x", "dlx"].includes(subcommand)) {
    rationale.push(`${executable} ${subcommand} executes repository code and may be long-running`);
    return mutation("command.long_running", "command.long_running", rationale, true, subcommand === "dlx", args.join(" "));
  }
  rationale.push(`${executable} command is not proven read-only`);
  return mutation("command.execute", "command.execute", rationale, false, NETWORK_EXECUTABLES.has(executable), args.join(" "), "low");
}

function readonly(command: string, rationale: string[]): CommandClassification {
  return {
    command,
    action: "read.repository",
    requiredPermission: "repository.read",
    confidence: "high",
    mutating: false,
    longRunning: false,
    network: false,
    rationale,
  };
}

function mutation(
  action: ActionKind,
  permission: Permission,
  rationale: string[],
  longRunning: boolean,
  network: boolean,
  command: string,
  confidence: CommandClassification["confidence"] = "high",
): CommandClassification {
  return {
    command,
    action,
    requiredPermission: permission,
    confidence,
    mutating: true,
    longRunning,
    network,
    rationale,
  };
}

export function classifyShellCommand(command: string): CommandClassification {
  const rationale: string[] = [];
  if (!command.trim()) {
    return mutation("command.execute", "command.execute", ["empty command is not executable"], false, false, command, "low");
  }

  if (containsRedirection(command)) {
    rationale.push("shell output redirection can modify files");
    return mutation("write.file", "file.write", rationale, false, false, command);
  }

  let args: string[];
  try {
    args = splitCommandLine(command);
  } catch {
    return mutation("command.execute", "command.execute", ["command could not be parsed safely"], false, false, command, "low");
  }

  const executable = (args[0] ?? "").split("/").at(-1)?.toLowerCase() ?? "";
  if (!executable) {
    return mutation("command.execute", "command.execute", ["missing executable"], false, false, command, "low");
  }

  if (/[;&`]|\$\(/.test(command)) {
    rationale.push("compound command or command substitution requires explicit approval");
    return mutation("command.execute", "command.execute", rationale, LONG_RUNNING_EXECUTABLES.has(executable), NETWORK_EXECUTABLES.has(executable), command, "medium");
  }

  if (executable === "git") return classifyGit(args, rationale);
  if (executable === "jj") return classifyJj(args, rationale);
  if (executable === "bd") return classifyBeads(args, rationale);
  if (["npm", "aube", "aubr", "aubx", "pnpm", "yarn"].includes(executable)) return classifyPackageManager(executable, args, rationale);

  if (executable === "sed" && args.some((arg) => arg === "-i" || arg.startsWith("-i"))) {
    rationale.push("sed -i modifies files in place");
    return mutation("write.file", "file.write", rationale, false, false, command);
  }
  if (executable === "perl" && args.some((arg) => /^-[^-]*i/.test(arg))) {
    rationale.push("perl -i modifies files in place");
    return mutation("write.file", "file.write", rationale, false, false, command);
  }
  if (MUTATING_EXECUTABLES.has(executable)) {
    rationale.push(`${executable} can modify filesystem state`);
    return mutation("write.file", "file.write", rationale, false, false, command);
  }
  if (READ_ONLY_COMMANDS.has(executable)) {
    rationale.push(`${executable} is in the read-only command allowlist`);
    return readonly(command, rationale);
  }
  if (["cargo", "go", "make", "mvn", "gradle", "gradlew", "pytest", "tox"].includes(executable)) {
    rationale.push(`${executable} executes repository code and may be long-running`);
    return mutation("command.long_running", "command.long_running", rationale, true, false, command, "medium");
  }
  if (NETWORK_EXECUTABLES.has(executable)) {
    rationale.push(`${executable} may access the network`);
    return mutation("network.access", "network.access", rationale, false, true, command, "medium");
  }

  rationale.push("command is not proven read-only");
  return mutation("command.execute", "command.execute", rationale, LONG_RUNNING_EXECUTABLES.has(executable), false, command, "low");
}
