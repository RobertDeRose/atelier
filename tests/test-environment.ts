import { fileURLToPath } from "node:url";

// Test processes must not inherit workstation Git signing, hooks, credential,
// pager, or system configuration. Several integration fixtures create commits;
// using the developer's global config makes the suite depend on an available
// GPG/SSH agent and can execute user-installed hooks.
for (const key of Object.keys(process.env)) {
  if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete process.env[key];
}
for (const key of [
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_TEMPLATE_DIR",
]) delete process.env[key];
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_ATTR_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = fileURLToPath(new URL("./fixtures/isolated.gitconfig", import.meta.url));
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GCM_INTERACTIVE = "Never";
process.env.GIT_PAGER = "cat";
process.env.PAGER = "cat";
