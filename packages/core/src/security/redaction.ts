import { isSecretEnvironmentName } from "../process/environment.ts";

const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]"],
  [/(authorization\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]"],
  [/((?:token|secret|password|passwd|api[_-]?key|credential)\s*[:=]\s*)["']?[^\s"',;]+/gi, "$1[REDACTED]"],
];

export function redactText(value: string, environment: NodeJS.ProcessEnv = process.env): string {
  let output = value;
  for (const [name, secret] of Object.entries(environment)) {
    if (!secret || secret.length < 8 || !isSecretEnvironmentName(name)) continue;
    output = output.split(secret).join("[REDACTED]");
  }
  for (const [pattern, replacement] of VALUE_PATTERNS) output = output.replace(pattern, replacement);
  return output;
}

export function redactValue<T>(value: T): T {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return redactText(item);
    if (item === null || typeof item !== "object") return item;
    if (seen.has(item)) throw new TypeError("Cannot redact circular structure.");
    seen.add(item);
    try {
      if (Array.isArray(item)) return item.map((entry) => visit(entry));
      const record: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item as Record<string, unknown>)) {
        record[key] = isSecretEnvironmentName(key) ? "[REDACTED]" : visit(entry);
      }
      return record;
    } finally {
      seen.delete(item);
    }
  };
  return visit(value) as T;
}
