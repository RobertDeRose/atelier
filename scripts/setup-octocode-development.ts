import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const configPath = resolve(process.env.ATLR_OCTOCODE_CONFIG_PATH ?? join(root, ".atelier", "octocode-config.toml"));
const markerPath = resolve(process.env.ATLR_OCTOCODE_CONFIG_MARKER ?? join(root, ".atelier", "octocode-config.managed.json"));
const codeModel = process.env.ATLR_OCTOCODE_CODE_MODEL ?? "fastembed:jinaai/jina-embeddings-v2-base-code";
const textModel = process.env.ATLR_OCTOCODE_TEXT_MODEL ?? "fastembed:nomic-ai/nomic-embed-text-v1.5";

mkdirSync(dirname(configPath), { recursive: true });
const managed = existsSync(markerPath);
let created = false;

if (!existsSync(configPath)) {
  const result = spawnSync("octocode", [
    "config",
    "--code-embedding-model", codeModel,
    "--text-embedding-model", textModel,
    "--graphrag-enabled", "true",
  ], {
    cwd: root,
    env: { ...process.env, OCTOCODE_CONFIG_PATH: configPath },
    encoding: "utf8",
    shell: false,
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || result.error?.message || "Unable to create project-local Octocode configuration.\n");
    process.exit(1);
  }
  created = true;
  writeFileSync(markerPath, `${JSON.stringify({ version: 1, codeModel, textModel, graphRag: true }, null, 2)}\n`);
}

const content = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
const report = {
  configPath,
  managed: created || managed,
  created,
  codeModel: content.match(/code_model\s*=\s*"([^"]+)"/)?.[1] ?? null,
  textModel: content.match(/text_model\s*=\s*"([^"]+)"/)?.[1] ?? null,
  graphRagEnabled: /\[graphrag\][\s\S]*?enabled\s*=\s*true/.test(content),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
