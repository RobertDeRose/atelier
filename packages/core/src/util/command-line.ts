import { ConfigurationError } from "../domain/errors.ts";

export function splitCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;

  for (const character of commandLine.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }

    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      continue;
    }

    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      continue;
    }

    if (/\s/.test(character) && quote === undefined) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaped) {
    current += "\\";
  }
  if (quote !== undefined) {
    throw new ConfigurationError("Unterminated quote in command line", { commandLine });
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
