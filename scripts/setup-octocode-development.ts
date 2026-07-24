import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const configPath = resolve(process.env.ATLR_OCTOCODE_CONFIG_PATH ?? join(root, ".atelier", "octocode-config.toml"));
const markerPath = resolve(process.env.ATLR_OCTOCODE_CONFIG_MARKER ?? join(root, ".atelier", "octocode-config.managed.json"));
const codeModel = process.env.ATLR_OCTOCODE_CODE_MODEL ?? "fastembed:jinaai/jina-embeddings-v2-base-code";
const textModel = process.env.ATLR_OCTOCODE_TEXT_MODEL ?? "fastembed:nomic-ai/nomic-embed-text-v1.5";

mkdirSync(dirname(configPath), { recursive: true });
const markerExists = existsSync(markerPath);
const configExists = existsSync(configPath);
const existing = configExists ? readFileSync(configPath, "utf8") : "";
const existingCodeModel = existing.match(/code_model\s*=\s*"([^"]+)"/)?.[1];
const existingTextModel = existing.match(/text_model\s*=\s*"([^"]+)"/)?.[1];
const existingGraphRag = /\[graphrag\][\s\S]*?enabled\s*=\s*true/.test(existing);
const managed = markerExists || !configExists;
const needsWrite = !configExists || (markerExists && (existingCodeModel !== codeModel || existingTextModel !== textModel || !existingGraphRag));

if (needsWrite) {
  const content = `version = 1

[embedding]
code_model = ${JSON.stringify(codeModel)}
text_model = ${JSON.stringify(textModel)}

[graphrag]
enabled = true
use_llm = false

[graphrag.llm]
description_model = "openrouter:openai/gpt-4o-mini"
relationship_model = "openrouter:openai/gpt-4o-mini"
ai_batch_size = 8
max_batch_tokens = 16384
batch_timeout_seconds = 60
fallback_to_individual = true
max_sample_tokens = 1500
confidence_threshold = 0.6
architectural_weight = 0.9
relationship_system_prompt = "GraphRAG LLM processing is disabled for Atelier development."
description_system_prompt = "GraphRAG LLM processing is disabled for Atelier development."
`;
  writeFileSync(configPath, content, "utf8");
  writeFileSync(markerPath, `${JSON.stringify({ version: 1, codeModel, textModel, graphRag: true }, null, 2)}\n`, "utf8");
}

const content = readFileSync(configPath, "utf8");
const report = {
  configPath,
  managed,
  created: !configExists && needsWrite,
  updated: configExists && needsWrite,
  codeModel: content.match(/code_model\s*=\s*"([^"]+)"/)?.[1] ?? null,
  textModel: content.match(/text_model\s*=\s*"([^"]+)"/)?.[1] ?? null,
  graphRagEnabled: /\[graphrag\][\s\S]*?enabled\s*=\s*true/.test(content),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
