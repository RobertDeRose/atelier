import { existsSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  classifyShellCommand,
  resolveSandboxBackend,
  resolveAbsolutePath,
  resolveAccessPath,
  isAccessEntryWithin,
  isSourcePathWithin,
  isDependencyPathWithin,
  type AtelierCore,
  type FilesystemEffect,
} from "../../../packages/core/src/index.ts";

function commandText(event: any): string {
  return typeof event.input?.command === "string" ? event.input.command.trim() : "";
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Small shell lexer used only to identify obvious paths. Ambiguous syntax stays unknown. */
function words(segment: string): string[] {
  const result: string[] = [];
  const expression = /"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g;
  for (const match of segment.matchAll(expression)) result.push(unquote(match[0]));
  return result;
}

function pathFrom(cwd: string, value: string): string | undefined {
  const clean = value.replace(/[;,]$/, "");
  if (
    !clean
    || clean === "-"
    || clean.startsWith("~")
    || /[$`]|\$\(|[<>|;&*?\[\]{}]/.test(clean)
  ) return undefined;
  try {
    return resolveAbsolutePath(clean, cwd);
  } catch {
    return undefined;
  }
}

function pathEffect(
  cwd: string,
  kind: FilesystemEffect["kind"],
  raw: string,
  description: string,
  options: Pick<FilesystemEffect, "destructive" | "preservesPrevious"> = {},
): FilesystemEffect {
  const path = pathFrom(cwd, raw);
  return path === undefined
    ? { kind: "unknown", description: `${description}: unresolved path ${raw}` }
    : { kind, path, description, ...options };
}

function explicitRedirections(command: string, cwd: string): FilesystemEffect[] {
  const effects: FilesystemEffect[] = [];
  const expression = /(?:^|\s)(?:(?:1|2)?(>>|>)|&>)\s*("(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|]+)/g;
  for (const match of command.matchAll(expression)) {
    const operator = match[1] ?? ">";
    const raw = unquote(match[2]!);
    const path = pathFrom(cwd, raw);
    if (path === undefined) {
      effects.push({ kind: "unknown", description: `shell redirection target cannot be resolved: ${raw}` });
      continue;
    }
    if (path === "/dev/null") continue;
    effects.push({
      kind: operator === ">>" ? "mutate" : existsSync(path) ? "overwrite" : "create",
      path,
      destructive: operator !== ">>",
      preservesPrevious: operator === ">>",
      description: `shell redirection ${operator}`,
    });
  }
  return effects;
}

function nonOptionArguments(tokens: readonly string[], start = 1): string[] {
  const result: string[] = [];
  let optionsEnded = false;
  for (const token of tokens.slice(start)) {
    if (!optionsEnded && token === "--") { optionsEnded = true; continue; }
    if (!optionsEnded && token.startsWith("-")) continue;
    result.push(token);
  }
  return result;
}


function searchCommandPaths(tokens: readonly string[]): string[] {
  const optionsWithValues = new Set([
    "-g", "--glob", "--iglob", "--ignore-file", "-t", "--type", "-T", "--type-not",
    "--sort", "--sortr", "--pre", "--pre-glob", "--engine", "--encoding", "-m", "--max-count",
    "-A", "--after-context", "-B", "--before-context", "-C", "--context", "-e", "--regexp", "-f", "--file",
    "--include", "--exclude", "--exclude-dir",
  ]);
  const positional: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") {
      positional.push(...tokens.slice(index + 1));
      break;
    }
    const optionName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    if (optionsWithValues.has(optionName)) {
      if (!token.includes("=")) index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    positional.push(token);
  }
  if (positional.length === 0) return [];
  // The first positional argument is the search pattern. Remaining values are
  // file or directory roots. With -e/--regexp the pattern is supplied by an
  // option, but treating the first positional as a root only broadens the read
  // inventory and never authorizes a mutation.
  return positional.slice(1);
}

function gitDiffOutputEffects(tokens: readonly string[], cwd: string): FilesystemEffect[] | undefined {
  const diffIndex = tokens.findIndex((token, index) => index > 0 && token === "diff");
  if (diffIndex < 0) return undefined;

  const effects: FilesystemEffect[] = [];
  for (let index = diffIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") break;

    let raw: string | undefined;
    if (token === "--output" || token === "-o") {
      raw = tokens[index + 1];
      index += 1;
    } else if (token.startsWith("--output=")) {
      raw = token.slice("--output=".length);
    } else if (token.startsWith("-o") && token.length > 2) {
      raw = token.slice(2);
    } else {
      continue;
    }

    if (raw === undefined) {
      effects.push({ kind: "unknown", description: "git diff output path is missing" });
      continue;
    }
    const path = pathFrom(cwd, raw);
    if (path === undefined) {
      effects.push({ kind: "unknown", description: `git diff output path cannot be resolved: ${raw}` });
      continue;
    }
    const exists = existsSync(path);
    effects.push({
      kind: exists ? "overwrite" : "create",
      path,
      destructive: exists,
      preservesPrevious: false,
      description: "git diff output file",
    });
  }
  return effects.length > 0 ? effects : undefined;
}

function segmentEffects(segment: string, cwd: string, runtimeConfined: boolean): FilesystemEffect[] {
  const tokens = words(segment);
  if (tokens.length === 0) return [];
  const executable = tokens[0]!;
  const args = tokens.slice(1);

  if (["sudo", "doas", "su", "pkexec"].includes(executable)) {
    return [{ kind: "privilege_escalation", description: segment }];
  }
  if (["curl", "wget", "ssh", "scp", "rsync", "nc", "ncat", "socat"].includes(executable)) {
    return [{ kind: "network", description: segment }];
  }
  if (executable === "rm") {
    return nonOptionArguments(tokens).map((target) => pathEffect(cwd, "delete", target, "rm target", { destructive: true }));
  }
  if (executable === "cp" || executable === "install") {
    const paths = nonOptionArguments(tokens);
    if (paths.length < 2) return [{ kind: "unknown", description: `${executable} destination is indeterminate` }];
    const destination = paths.at(-1)!;
    const resolved = pathFrom(cwd, destination);
    return resolved === undefined
      ? [{ kind: "unknown", description: `${executable} destination cannot be resolved` }]
      : [{ kind: existsSync(resolved) ? "overwrite" : "create", path: resolved, destructive: existsSync(resolved), preservesPrevious: false, description: `${executable} destination` }];
  }
  if (executable === "mv") {
    const paths = nonOptionArguments(tokens);
    if (paths.length < 2) return [{ kind: "unknown", description: "mv source or destination is indeterminate" }];
    const source = pathEffect(cwd, "delete", paths[0]!, "mv source", { destructive: true });
    const destinationPath = pathFrom(cwd, paths.at(-1)!);
    const destination: FilesystemEffect = destinationPath === undefined
      ? { kind: "unknown", description: "mv destination cannot be resolved" }
      : { kind: existsSync(destinationPath) ? "overwrite" : "create", path: destinationPath, destructive: existsSync(destinationPath), preservesPrevious: false, description: "mv destination" };
    return [source, destination];
  }
  if (executable === "truncate") {
    const targets = nonOptionArguments(tokens);
    return targets.length === 0
      ? [{ kind: "unknown", description: "truncate target is indeterminate" }]
      : targets.map((target) => pathEffect(cwd, "overwrite", target, "truncate target", { destructive: true, preservesPrevious: false }));
  }
  if (executable === "mkdir") {
    return nonOptionArguments(tokens).map((target) => pathEffect(cwd, "create", target, "mkdir target"));
  }
  if (executable === "touch") {
    return nonOptionArguments(tokens).map((target) => {
      const path = pathFrom(cwd, target);
      return path === undefined
        ? { kind: "unknown", description: "touch target cannot be resolved" }
        : { kind: existsSync(path) ? "mutate" : "create", path, preservesPrevious: true, description: "touch target" };
    });
  }
  if (executable === "find" && args.includes("-delete")) {
    return [{ kind: "unknown", destructive: true, indeterminateDestructive: true, description: "find -delete can affect an indeterminate path set" }];
  }
  if (executable === "find" && args.some((value) => value === "-exec" || value === "-execdir")) {
    return [{ kind: "unknown", destructive: true, indeterminateDestructive: true, description: "find -exec effects cannot be enumerated exactly" }];
  }
  if (executable === "find") {
    const roots: string[] = [];
    for (const token of tokens.slice(1)) {
      if (token.startsWith("-") || token === "!" || token === "(") break;
      roots.push(token);
    }
    return (roots.length === 0 ? [cwd] : roots).map((target) =>
      pathEffect(cwd, "read", target, "find search root"));
  }
  if (executable === "sort") {
    const outputIndex = args.findIndex((value) => value === "-o" || value === "--output");
    if (outputIndex >= 0 && args[outputIndex + 1] !== undefined) {
      const output = args[outputIndex + 1]!;
      const resolved = pathFrom(cwd, output);
      return resolved === undefined
        ? [{ kind: "unknown", description: "sort output cannot be resolved" }]
        : [{ kind: existsSync(resolved) ? "overwrite" : "create", path: resolved, destructive: existsSync(resolved), preservesPrevious: false, description: "sort output" }];
    }
    return [{ kind: "read", path: cwd, description: "sort reads stdin or files without persistent output" }];
  }
  if (executable === "git") {
    const subcommand = args.find((value) => !value.startsWith("-"));
    if (subcommand === "diff") {
      const outputEffects = gitDiffOutputEffects(tokens, cwd);
      if (outputEffects !== undefined) return outputEffects;
    }
    if (["status", "diff", "log", "show", "rev-parse", "ls-files", "branch"].includes(subcommand ?? "")) {
      return [{ kind: "read", path: cwd, description: `git ${subcommand} inspection` }];
    }
    if (subcommand === "reset" && args.includes("--hard")) {
      return [{ kind: "overwrite", path: cwd, destructive: true, description: "git reset --hard working tree" }];
    }
    if (subcommand === "restore" || subcommand === "checkout") {
      const separator = args.indexOf("--");
      const candidates = separator >= 0 ? args.slice(separator + 1) : args.slice(1).filter((value) => !value.startsWith("-"));
      return candidates.length === 0
        ? [{ kind: "overwrite", path: cwd, destructive: true, description: `git ${subcommand} working tree` }]
        : candidates.map((target) => pathEffect(cwd, "overwrite", target, `git ${subcommand} target`, { destructive: true }));
    }
  }
  if (executable === "jj") {
    const subcommand = args.find((value) => !value.startsWith("-"));
    if (["status", "diff", "log", "show", "root", "workspace", "op"].includes(subcommand ?? "")) {
      return [{ kind: "read", path: cwd, description: `jj ${subcommand} inspection` }];
    }
    if (subcommand === "restore") {
      const candidates = args.slice(1).filter((value) => !value.startsWith("-"));
      return candidates.length === 0
        ? [{ kind: "overwrite", path: cwd, destructive: true, description: "jj restore working copy" }]
        : candidates.map((target) => pathEffect(cwd, "overwrite", target, "jj restore target", { destructive: true }));
    }
  }
  if (executable === "bd") {
    const subcommand = args.find((value) => !value.startsWith("-")) ?? "";
    const readOnly = ["blocked", "children", "graph", "info", "list", "prime", "ready", "show", "status", "version", "where"];
    const readOnlyDependency = subcommand === "dep"
      && ["", "cycles", "list", "tree"].includes(args.slice(args.indexOf(subcommand) + 1).find((value) => !value.startsWith("-")) ?? "");
    if (readOnly.includes(subcommand) || readOnlyDependency) {
      return [{ kind: "read", path: cwd, description: `bd ${subcommand || "command"} inspection` }];
    }
  }

  if (executable === "rg" || executable === "grep") {
    const roots = searchCommandPaths(tokens);
    return (roots.length === 0 ? [cwd] : roots).map((target) => pathEffect(cwd, "read", target, `${executable} search root`));
  }
  const readCommands = new Set(["cat", "head", "tail", "less", "ls", "pwd", "stat", "wc", "file", "readlink", "printf", "echo", "test", "true", "false"]);
  if (readCommands.has(executable) || (executable === "sed" && args.includes("-n"))) {
    if (["printf", "echo", "test", "true", "false", "pwd"].includes(executable)) {
      return [{ kind: "read", path: cwd, description: `${executable} has no persistent effect` }];
    }
    const pathArguments = nonOptionArguments(tokens).filter((value) => !value.startsWith("+") && value !== ".");
    if (pathArguments.length === 0) return [{ kind: "read", path: cwd, description: `${executable} workspace read` }];
    return pathArguments.map((target) => pathEffect(cwd, "read", target, `${executable} read target`));
  }

  // Interpreters, scripts, build systems, and compound commands are safe to run
  // without a prompt only when the actual Bash executor is OS-confined.
  return [{
    kind: "execute",
    path: cwd,
    runtimeConfined,
    description: `sandboxed shell execution: ${segment}`,
  }];
}


function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "single") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      current += char;
      continue;
    }
    if (char === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      current += char;
      continue;
    }
    if (quote === undefined && (char === ";" || char === "|" || char === "\n" || (char === "&" && command[index + 1] === "&"))) {
      const value = current.trim();
      if (value) segments.push(value);
      current = "";
      if ((char === "|" && command[index + 1] === "|") || (char === "&" && command[index + 1] === "&")) index += 1;
      continue;
    }
    current += char;
  }
  const value = current.trim();
  if (value) segments.push(value);
  return segments;
}

function shellEffects(command: string, cwd: string, runtimeConfined: boolean): FilesystemEffect[] {
  if (!command.trim()) return [{ kind: "execute", path: cwd, runtimeConfined, description: "empty shell command" }];
  const classification = classifyShellCommand(command);
  const classificationReadOnly = classification.action === "read.repository"
    && classification.mutating === false
    && classification.risk === "routine";
  const effects = explicitRedirections(command, cwd);
  // Command substitution can hide destructive path sets. The sandbox still
  // constrains writes, but exact recovery cannot be promised for destructive
  // substitutions, so require approval when a destructive token is nested.
  if (/(?:\$\(|`)[\s\S]*(?:rm|truncate|restore|reset\s+--hard|find[^\n]*-delete)/.test(command)) {
    effects.push({ kind: "unknown", destructive: true, indeterminateDestructive: true, description: "destructive command substitution" });
  }
  const segments = splitShellSegments(command);
  for (const segment of segments) effects.push(...segmentEffects(segment, cwd, runtimeConfined));
  if (!classificationReadOnly && effects.every((effect) => effect.kind === "read")) {
    if (classification.action === "network.access" || classification.risk === "external") {
      effects.push({ kind: "network", description: classification.rationale.join("; ") || command });
    } else {
      effects.push({
        kind: classification.risk === "destructive" ? "unknown" : "execute",
        path: cwd,
        runtimeConfined,
        destructive: classification.risk === "destructive",
        indeterminateDestructive: classification.risk === "destructive",
        description: classification.rationale.join("; ") || command,
      });
    }
  }
  return effects.length > 0 ? effects : [{ kind: "execute", path: cwd, runtimeConfined, description: command }];
}

function sandboxIsAvailable(core: AtelierCore): boolean {
  return resolveSandboxBackend(core.config.sandboxBackend).available;
}

function applyReviewedTaskScope(
  effects: readonly FilesystemEffect[],
  approvedTaskPaths: readonly string[],
  approvedDependencyPaths: readonly string[],
  repositoryRoot: string,
): FilesystemEffect[] {
  if (approvedTaskPaths.length === 0) return [...effects];
  return effects.map((effect) => {
    if (!["create", "mutate", "delete", "overwrite"].includes(effect.kind) || effect.path === undefined) return effect;
    const inTaskScope = approvedTaskPaths.some((approvedPath) => isAccessEntryWithin(effect.path!, approvedPath, "write"));
    const dependency = isDependencyPathWithin(repositoryRoot, effect.path);
    const inDependencyScope = approvedDependencyPaths.some((approvedPath) => isAccessEntryWithin(effect.path!, approvedPath, "write"));
    const source = isSourcePathWithin(repositoryRoot, effect.path);
    if (inTaskScope && source && (!dependency || inDependencyScope)) return effect;
    return {
      ...effect,
      requiresExplicitApproval: true,
      description: `${effect.description ?? "shell write"} is outside the reviewed task source scope`,
    };
  });
}

export function effectsForTool(event: any, ctx: ExtensionContext, core: AtelierCore): FilesystemEffect[] {
  const path = typeof event.input?.path === "string" ? resolveAbsolutePath(event.input.path, ctx.cwd) : undefined;
  if (["read", "grep", "find", "ls"].includes(event.toolName)) {
    const target = path ?? (typeof event.input?.directory === "string"
      ? resolveAbsolutePath(event.input.directory, ctx.cwd)
      : resolveAccessPath(ctx.cwd, "read"));
    return [{ kind: "read", path: target, description: `${event.toolName} target` }];
  }
  if (event.toolName === "write") {
    if (path === undefined) return [{ kind: "unknown", description: "write without a path" }];
    return [{ kind: existsSync(path) ? "overwrite" : "create", path, destructive: existsSync(path), preservesPrevious: false, description: "typed write" }];
  }
  if (event.toolName === "edit") {
    return path === undefined
      ? [{ kind: "unknown", description: "edit without a path" }]
      : [{ kind: existsSync(path) ? "mutate" : "create", path, preservesPrevious: true, description: "typed edit" }];
  }
  if (event.toolName === "bash") return effectsForShellCommand(
    commandText(event),
    ctx.cwd,
    sandboxIsAvailable(core),
    core.approvedTaskPaths(),
    core.approvedDependencyPaths(),
    core.config.repositoryRoot,
  );
  if (event.toolName.startsWith("atlr_code_") || event.toolName === "atlr_state") {
    return [{ kind: "read", path: ctx.cwd, description: `Atelier ${event.toolName} read` }];
  }
  if (event.toolName === "atlr_validate") return [{ kind: "execute", path: ctx.cwd, runtimeConfined: false, description: "declared validation" }];
  if (event.toolName === "atlr_commit" || event.toolName === "atlr_task_close") return [{ kind: "mutate", path: ctx.cwd, preservesPrevious: true, description: event.toolName }];
  return [{ kind: "unknown", description: `custom tool ${String(event.toolName)}` }];
}

export function effectsForUserBash(command: string, cwd: string, core: AtelierCore): FilesystemEffect[] {
  return effectsForShellCommand(command, cwd, sandboxIsAvailable(core));
}

/**
 * Authoritative Pi shell-effect analysis. The hardened command classifier is
 * a fail-closed gate over path-specific parsing so a command can inherit
 * repository-read authorization only when both layers agree it is read-only.
 */
export function effectsForShellCommand(
  command: string,
  cwd: string,
  runtimeConfined: boolean,
  approvedTaskPaths: readonly string[] = [],
  approvedDependencyPaths: readonly string[] = [],
  repositoryRoot: string = cwd,
): FilesystemEffect[] {
  return applyReviewedTaskScope(
    shellEffects(command, cwd, runtimeConfined),
    approvedTaskPaths,
    approvedDependencyPaths,
    repositoryRoot,
  );
}
