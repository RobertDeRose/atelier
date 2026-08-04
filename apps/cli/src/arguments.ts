export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgs(args: string[]): ParsedArgs {
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

export function flagString(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags.get(key);
  return typeof value === "string" ? value : undefined;
}

export function flagBoolean(args: ParsedArgs, key: string): boolean {
  const value = args.flags.get(key);
  return value === true || value === "true";
}

const LAUNCH_GLOBAL_VALUE_FLAGS = new Set(["root", "workspace", "retrieval-session"]);

export function stripLaunchArguments(raw: string[]): string[] {
  const commandIndex = raw.indexOf("launch");
  if (commandIndex === -1) return [];

  const forwarded: string[] = [];
  for (let index = commandIndex + 1; index < raw.length; index += 1) {
    const argument = raw[index];
    if (argument === undefined) continue;
    if (argument === "--") continue;
    if (!argument.startsWith("--")) {
      forwarded.push(argument);
      continue;
    }
    const equalsIndex = argument.indexOf("=");
    const flagName = argument.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (!LAUNCH_GLOBAL_VALUE_FLAGS.has(flagName)) {
      forwarded.push(argument);
      continue;
    }
    if (equalsIndex === -1) index += 1;
  }
  return forwarded;
}
