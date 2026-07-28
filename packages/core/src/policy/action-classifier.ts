import type { ActionKind, OperationRisk, Permission } from "../domain/types.ts";
import { splitCommandLine } from "../util/command-line.ts";

export interface CommandClassification {
  command: string;
  action: ActionKind;
  requiredPermission?: Permission;
  confidence: "high" | "medium" | "low";
  mutating: boolean;
  longRunning: boolean;
  network: boolean;
  risk: OperationRisk;
  rationale: string[];
}

const READ_ONLY_COMMANDS = new Set([
  "basename",
  "cat",
  "cut",
  "dirname",
  "du",
  "grep",
  "head",
  "jq",
  "ls",
  "printf",
  "pwd",
  "stat",
  "tail",
  "test",
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
  const command = args.join(" ");
  const readOnly = new Set(["diff", "grep", "log", "ls-files", "rev-parse", "show", "status"]);
  const destructive = new Set(["clean", "reset", "restore"]);
  if (readOnly.has(subcommand)) {
    rationale.push(`git ${subcommand} is read-only within the selected repository`);
    return readonly(command, rationale);
  }
  if (subcommand === "branch") {
    const tail = args.slice(2);
    const listing = tail.length === 0 || tail[0] === "--list" || tail[0] === "--show-current";
    if (listing) {
      rationale.push("git branch is in an explicit listing form");
      return readonly(command, rationale);
    }
    const risk: OperationRisk = tail.some((arg) => ["-d", "-D", "--delete", "-m", "-M", "--move"].includes(arg))
      ? "destructive"
      : "routine";
    rationale.push("git branch arguments can create, move, copy, or delete references");
    return mutation("repository.change.create", "repository.change.create", rationale, false, false, command, "high", risk);
  }
  if (subcommand === "tag") {
    const tail = args.slice(2);
    const listing = tail.length === 0 || ["-l", "--list"].includes(tail[0] ?? "");
    if (listing) {
      rationale.push("git tag is in an explicit listing form");
      return readonly(command, rationale);
    }
    const risk: OperationRisk = tail.some((arg) => ["-d", "--delete", "-f", "--force"].includes(arg))
      ? "destructive"
      : "routine";
    rationale.push("git tag arguments can create, replace, or delete references");
    return mutation("repository.change.create", "repository.change.create", rationale, false, false, command, "high", risk);
  }
  if (destructive.has(subcommand) || (subcommand === "checkout" && args.includes("--"))) {
    rationale.push(`git ${subcommand} can discard working-copy or repository state`);
    return mutation("repository.change.create", "repository.change.create", rationale, false, false, command, "high", "destructive");
  }
  if (["fetch", "ls-remote", "pull", "push", "remote"].includes(subcommand)) {
    rationale.push(`git ${subcommand} may access the network or mutate repository state`);
    const action: ActionKind = subcommand === "push" ? "repository.publish" : "network.access";
    const permission: Permission = subcommand === "push" ? "repository.publish" : "network.access";
    return mutation(action, permission, rationale, false, true, command, "high", "external");
  }
  rationale.push(`git ${subcommand || "command"} can mutate repository state`);
  return mutation("repository.change.create", "repository.change.create", rationale, false, false, command);
}

function classifyJj(args: string[], rationale: string[]): CommandClassification {
  const subcommand = args[1] ?? "";
  const command = args.join(" ");
  if (["diff", "log", "show", "status"].includes(subcommand)) {
    rationale.push(`jj ${subcommand} is read-only`);
    return readonly(command, rationale);
  }
  if (subcommand === "file") {
    const fileCommand = args[2] ?? "";
    if (["", "list", "show"].includes(fileCommand)) {
      rationale.push(`jj file ${fileCommand || "help"} is read-only`);
      return readonly(command, rationale);
    }
    const risk: OperationRisk = ["untrack", "forget"].includes(fileCommand) ? "destructive" : "routine";
    rationale.push(`jj file ${fileCommand} changes tracked file state`);
    return mutation("repository.change.create", "repository.change.create", rationale, false, false, command, "high", risk);
  }
  if (subcommand === "op") {
    const operation = args[2] ?? "";
    if (["", "log", "show"].includes(operation)) {
      rationale.push(`jj op ${operation || "help"} is read-only`);
      return readonly(command, rationale);
    }
    rationale.push("jj op subcommand can restore or mutate repository state");
    return mutation("repository.change.create", "repository.change.create", rationale, false, false, command, "high", "destructive");
  }
  if (subcommand === "workspace") {
    const workspace = args[2] ?? "";
    if (["", "list", "root"].includes(workspace)) {
      rationale.push(`jj workspace ${workspace || "help"} is read-only`);
      return readonly(command, rationale);
    }
    rationale.push("jj workspace subcommand can create or remove workspaces");
    const risk: OperationRisk = ["forget", "remove"].includes(workspace) ? "destructive" : "routine";
    return mutation("repository.workspace.create", "repository.workspace.create", rationale, false, false, command, "high", risk);
  }
  if (["abandon", "restore", "undo"].includes(subcommand)) {
    rationale.push(`jj ${subcommand} can discard or rewrite repository state`);
    return mutation("repository.change.create", "repository.change.create", rationale, false, false, command, "high", "destructive");
  }
  if (subcommand === "git" && args[2] === "push") {
    rationale.push("jj git push publishes repository state");
    return mutation("repository.publish", "repository.publish", rationale, false, true, command, "high", "external");
  }
  rationale.push(`jj ${subcommand || "command"} can mutate repository state`);
  return mutation("repository.change.create", "repository.change.create", rationale, false, false, command);
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
    const risk: OperationRisk = ["remove", "uninstall", "unlink"].includes(subcommand) ? "destructive" : "routine";
    return mutation("dependency.modify", "dependency.modify", rationale, true, true, args.join(" "), "high", risk);
  }
  if (["test", "check", "lint", "run", "exec", "x", "dlx"].includes(subcommand)) {
    rationale.push(`${executable} ${subcommand} executes repository code and may be long-running`);
    return mutation("command.long_running", "command.long_running", rationale, true, subcommand === "dlx", args.join(" "));
  }
  rationale.push(`${executable} command is not proven read-only`);
  return mutation("command.execute", "command.execute", rationale, false, NETWORK_EXECUTABLES.has(executable), args.join(" "), "low");
}

function classifyMise(args: string[], rationale: string[]): CommandClassification {
  const subcommand = args[1] ?? "";
  if (["run", "exec", "x"].includes(subcommand)) {
    rationale.push(`mise ${subcommand} executes a declared repository task`);
    return mutation("command.long_running", "command.long_running", rationale, true, false, args.join(" "));
  }
  if (["install", "uninstall", "upgrade", "use"].includes(subcommand)) {
    rationale.push(`mise ${subcommand} changes the external development tool environment`);
    return mutation("network.access", "network.access", rationale, true, true, args.join(" "), "high", "external");
  }
  rationale.push("mise command is not proven repository-local");
  return mutation("command.execute", "command.execute", rationale, false, false, args.join(" "), "low", "unknown");
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
    risk: "routine",
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
  risk: OperationRisk = network ? "external" : "routine",
): CommandClassification {
  return {
    command,
    action,
    requiredPermission: permission,
    confidence,
    mutating: true,
    longRunning,
    network,
    risk,
    rationale,
  };
}

function stripSafeSinkRedirections(command: string): string {
  return command
    .replace(/(^|\s)\d*>>?\s*(?:\/dev\/null|&\d+)(?=\s|[;&|]|$)/g, "$1")
    .replace(/(^|\s)&>>?\s*\/dev\/null(?=\s|[;&|]|$)/g, "$1");
}

function splitCompoundCommands(command: string): string[] | undefined {
  const parts: string[] = [];
  let current = "";
  let single = false;
  let double = false;
  let escaped = false;

  const push = (): void => {
    const value = current.trim();
    if (value) parts.push(value);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    const next = command[index + 1];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && !single) {
      current += character;
      escaped = true;
      continue;
    }
    if (character === "'" && !double) {
      single = !single;
      current += character;
      continue;
    }
    if (character === '"' && !single) {
      double = !double;
      current += character;
      continue;
    }
    if (single || double) {
      current += character;
      continue;
    }
    if (character === "`" || (character === "$" && next === "(") || ((character === "<" || character === ">") && next === "(")) return undefined;
    if (character === "&") {
      if (next !== "&") return undefined;
      push();
      index += 1;
      continue;
    }
    if (character === "|") {
      push();
      if (next === "|") index += 1;
      continue;
    }
    if (character === ";" || character === "\n") {
      push();
      continue;
    }
    current += character;
  }
  if (single || double || escaped) return undefined;
  push();
  return parts;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function classifyFind(args: string[], command: string, rationale: string[]): CommandClassification {
  const mutatingFlags = new Set(["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
  const mutatingFlag = args.find((arg) => mutatingFlags.has(arg));
  if (mutatingFlag !== undefined) {
    rationale.push(`find ${mutatingFlag} modifies filesystem state`);
    const risk: OperationRisk = mutatingFlag === "-delete" ? "destructive" : "routine";
    return mutation("write.file", "file.write", rationale, false, false, command, "high", risk);
  }
  const execFlags = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
  for (let index = 1; index < args.length; index += 1) {
    if (!execFlags.has(args[index] ?? "")) continue;
    const invoked: string[] = [];
    index += 1;
    while (index < args.length && ![";", "+"].includes(args[index] ?? "")) {
      invoked.push(args[index]!);
      index += 1;
    }
    if (invoked.length === 0 || index >= args.length) {
      return mutation("command.execute", "command.execute", ["find execution clause could not be bounded safely"], false, false, command, "low");
    }
    const nested = classifyShellCommand(invoked.map(shellQuote).join(" "));
    if (nested.action !== "read.repository") {
      return {
        ...nested,
        command,
        rationale: [`find ${args[index] === "+" ? "batch execution" : "execution"} invokes ${invoked[0]}`, ...nested.rationale],
      };
    }
    rationale.push(`find execution invokes read-only ${invoked[0]}`);
  }
  rationale.push("find traversal is read-only");
  return readonly(command, rationale);
}

function classifyEnv(args: string[], command: string, rationale: string[]): CommandClassification {
  let index = 1;
  while (index < args.length) {
    const value = args[index] ?? "";
    if (value === "-i" || value === "--ignore-environment" || value.startsWith("--unset=")) {
      index += 1;
      continue;
    }
    if (value === "-u" || value === "--unset") {
      index += 2;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      index += 1;
      continue;
    }
    break;
  }
  const nested = args.slice(index);
  if (nested.length === 0) {
    rationale.push("env without a nested command only reads the environment");
    return readonly(command, rationale);
  }
  const classified = classifyShellCommand(nested.map(shellQuote).join(" "));
  return {
    ...classified,
    command,
    rationale: [`env invokes ${nested[0]}`, ...classified.rationale],
  };
}

function classifyFd(args: string[], command: string, rationale: string[]): CommandClassification {
  const executionIndex = args.findIndex((arg) => ["-x", "--exec", "-X", "--exec-batch"].includes(arg));
  if (executionIndex !== -1) {
    const nested = args.slice(executionIndex + 1);
    const classified = nested.length === 0
      ? mutation("command.execute", "command.execute", ["fd execution clause is incomplete"], false, false, command, "low")
      : classifyShellCommand(nested.map(shellQuote).join(" "));
    return {
      ...classified,
      command,
      rationale: [`fd executes a nested command through ${args[executionIndex]}`, ...classified.rationale],
    };
  }
  rationale.push("fd search has no execution option");
  return readonly(command, rationale);
}

function classifyRipgrep(args: string[], command: string, rationale: string[]): CommandClassification {
  if (args.some((arg) => arg === "--pre" || arg.startsWith("--pre="))) {
    rationale.push("rg --pre executes an arbitrary preprocessor");
    return mutation("command.execute", "command.execute", rationale, false, false, command, "high", "unknown");
  }
  rationale.push("rg search has no executable preprocessor");
  return readonly(command, rationale);
}

function classifySed(args: string[], command: string, rationale: string[]): CommandClassification {
  if (args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="))) {
    rationale.push("sed in-place mode modifies files");
    return mutation("write.file", "file.write", rationale, false, false, command);
  }
  rationale.push("sed is not using in-place mode");
  return readonly(command, rationale);
}

function classifySort(args: string[], command: string, rationale: string[]): CommandClassification {
  if (args.some((arg, index) => arg === "-o" || arg === "--output" || arg.startsWith("--output=") || (/^-o.+/.test(arg) && index > 0))) {
    rationale.push("sort output option writes a file");
    return mutation("write.file", "file.write", rationale, false, false, command);
  }
  rationale.push("sort is not configured with an output file");
  return readonly(command, rationale);
}

function classifySimpleCommand(command: string): CommandClassification {
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
  if (!executable) return mutation("command.execute", "command.execute", ["missing executable"], false, false, command, "low");

  if (executable === "git") return classifyGit(args, rationale);
  if (executable === "env") return classifyEnv(args, command, rationale);
  if (executable === "jj") return classifyJj(args, rationale);
  if (executable === "bd") return classifyBeads(args, rationale);
  if (executable === "mise") return classifyMise(args, rationale);
  if (["npm", "aube", "aubr", "aubx", "pnpm", "yarn"].includes(executable)) return classifyPackageManager(executable, args, rationale);
  if (executable === "find") return classifyFind(args, command, rationale);
  if (executable === "fd") return classifyFd(args, command, rationale);
  if (executable === "rg") return classifyRipgrep(args, command, rationale);
  if (executable === "sed") return classifySed(args, command, rationale);
  if (executable === "sort") return classifySort(args, command, rationale);
  if (["bash", "bun", "node", "python", "python3", "ruby", "tsx"].includes(executable)) {
    rationale.push(`${executable} executes repository-local code`);
    return mutation("command.execute", "command.execute", rationale, false, false, command);
  }

  if (executable === "perl" && args.some((arg) => /^-[^-]*i/.test(arg))) {
    rationale.push("perl -i modifies files in place");
    return mutation("write.file", "file.write", rationale, false, false, command);
  }
  if (MUTATING_EXECUTABLES.has(executable)) {
    rationale.push(`${executable} can modify filesystem state`);
    const risk: OperationRisk = ["dd", "mv", "rm", "rmdir", "truncate"].includes(executable)
      ? "destructive"
      : "routine";
    return mutation("write.file", "file.write", rationale, false, false, command, "high", risk);
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
    return mutation("network.access", "network.access", rationale, false, true, command, "medium", "external");
  }
  rationale.push("command is not proven read-only");
  return mutation("command.execute", "command.execute", rationale, LONG_RUNNING_EXECUTABLES.has(executable), false, command, "low", "unknown");
}

export function classifyShellCommand(command: string): CommandClassification {
  const sanitized = stripSafeSinkRedirections(command);
  const parts = splitCompoundCommands(sanitized);
  if (parts === undefined) {
    return mutation(
      "command.execute",
      "command.execute",
      ["background execution, command substitution, or malformed shell syntax requires explicit approval"],
      false,
      false,
      command,
      "medium",
    );
  }
  if (parts.length <= 1) {
    const classification = classifySimpleCommand(parts[0] ?? sanitized);
    return { ...classification, command };
  }

  const classifications = parts.map(classifySimpleCommand);
  const nonReadOnly = classifications.find((classification) => classification.action !== "read.repository");
  if (nonReadOnly !== undefined) {
    return {
      ...nonReadOnly,
      command,
      rationale: [
        `compound command contains a non-read-only segment: ${nonReadOnly.command}`,
        ...nonReadOnly.rationale,
      ],
    };
  }
  return readonly(command, [
    `all ${classifications.length} shell segments are independently read-only`,
    ...classifications.flatMap((classification) => classification.rationale),
  ]);
}
