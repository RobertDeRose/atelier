import { existsSync, readFileSync } from "node:fs";

const [configPath, statsPath] = process.argv.slice(2);
if (!configPath || !statsPath) throw new Error("Usage: inspect-octocode-environment.ts CONFIG_OUTPUT STATS_OUTPUT");

const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
const stats = existsSync(statsPath) ? readFileSync(statsPath, "utf8") : "";
const codeModel = config.match(/code_model\s*=\s*"([^"]+)"/i)?.[1]
  ?? config.match(/Code model:\s*(\S+)/i)?.[1]
  ?? stats.match(/Code model:\s*(\S+)/i)?.[1];
const textModel = config.match(/text_model\s*=\s*"([^"]+)"/i)?.[1]
  ?? config.match(/Text model:\s*(\S+)/i)?.[1]
  ?? stats.match(/Text model:\s*(\S+)/i)?.[1];
const provider = codeModel?.split(":", 1)[0]?.toLowerCase();
const requiredKey = provider === "voyage" ? "VOYAGE_API_KEY"
  : provider === "jina" ? "JINA_API_KEY"
  : provider === "google" ? "GOOGLE_API_KEY"
  : provider === "openai" ? "OPENAI_API_KEY"
  : provider === "octohub" ? "OCTOHUB_API_KEY"
  : provider === "together" ? "TOGETHER_API_KEY"
  : undefined;
const knownKeys = ["VOYAGE_API_KEY", "JINA_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "OCTOHUB_API_KEY", "TOGETHER_API_KEY"];
const keyPresence = Object.fromEntries(knownKeys.map((name) => [name, Boolean(process.env[name]?.trim())]));
const configured = requiredKey === undefined || keyPresence[requiredKey] === true;
const report = {
  codeModel: codeModel ?? null,
  textModel: textModel ?? null,
  provider: provider ?? null,
  requiredKey: requiredKey ?? null,
  configured,
  keyPresence,
  guidance: configured
    ? "Embedding provider prerequisites are available."
    : `${requiredKey} is required by ${codeModel ?? "the configured code model"}. Set it before indexing/searching, or use a build configured with a local embedding provider.`,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = configured ? 0 : 1;
