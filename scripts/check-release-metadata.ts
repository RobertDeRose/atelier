import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ATELIER_VERSION } from "../packages/core/src/version.ts";

const root = new URL("../", import.meta.url);
const rootPath = decodeURIComponent(root.pathname);
const failures: string[] = [];

function text(path: string): string {
  return readFileSync(join(rootPath, path), "utf8");
}

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

const packageJson = JSON.parse(text("package.json")) as {
  version?: string;
  main?: string;
  types?: string;
  bin?: Record<string, string>;
  pi?: { extensions?: string[] };
};
const packageLock = JSON.parse(text("package-lock.json")) as {
  version?: string;
  packages?: Record<string, { version?: string }>;
};
check(packageJson.version === ATELIER_VERSION, `package.json version must be ${ATELIER_VERSION}`);
check(packageLock.version === ATELIER_VERSION, `package-lock.json version must be ${ATELIER_VERSION}`);
check(packageLock.packages?.[""]?.version === ATELIER_VERSION, "package-lock root package version is inconsistent");
check(text("CHANGELOG.md").includes(`## ${ATELIER_VERSION} —`), "CHANGELOG.md lacks the current release heading");
check(text("README.md").includes(ATELIER_VERSION), "README.md lacks the current release version");
check(packageJson.main === "./dist/packages/core/src/index.js", "package main must reference built JavaScript");
check(packageJson.types === "./dist/packages/core/src/index.d.ts", "package types must reference built declarations");
check(packageJson.bin?.atlr === "./bin/atlr.mjs", "package CLI launcher is not declared");
check(packageJson.pi?.extensions?.[0] === "./dist/apps/pi-extension/src/index.js", "Pi package entry must reference built JavaScript");
check(statSync(join(rootPath, "bin/atlr.mjs")).mode % 0o1000 >= 0o100, "bin/atlr.mjs must be executable");
check(
  statSync(join(rootPath, "scripts/live-conformance.sh")).mode % 0o1000 >= 0o100,
  "scripts/live-conformance.sh must be executable",
);

const adrFiles = readdirSync(join(rootPath, "docs"))
  .filter((name) => /^ADR-\d{4}-.*\.md$/.test(name))
  .sort();
const identifiers = new Map<string, string>();
for (const name of adrFiles) {
  const identifier = /^ADR-(\d{4})-/.exec(name)?.[1];
  if (identifier === undefined) continue;
  const prior = identifiers.get(identifier);
  if (prior !== undefined) failures.push(`duplicate ADR-${identifier}: ${prior} and ${name}`);
  else identifiers.set(identifier, name);
  check(text(join("docs", name)).startsWith(`# ADR-${identifier}:`), `${name} heading does not match its identifier`);
}

for (const name of readdirSync(join(rootPath, "packages/core/src/domain")).filter((item) => item.endsWith(".ts"))) {
  check(!text(join("packages/core/src/domain", name)).includes('../code/'), `${name} recreates the domain/code dependency cycle`);
}

const decompositionLimits: Record<string, number> = {
  "apps/cli/src/main.ts": 550,
  "apps/pi-extension/src/index.ts": 1150,
  "packages/core/src/code/service.ts": 1400,
  "packages/core/src/ledger/sqlite-ledger.ts": 1150,
  "packages/core/src/state/working-state-builder.ts": 650,
};
for (const [path, limit] of Object.entries(decompositionLimits)) {
  const lines = text(path).split("\n").length;
  check(lines <= limit, `${path} has reconcentrated to ${lines} lines; limit is ${limit}`);
}
for (const path of [
  "apps/cli/src/arguments.ts",
  "apps/cli/src/command-handlers.ts",
  "apps/pi-extension/src/tool-authorization.ts",
  "apps/pi-extension/src/tool-activation.ts",
  "apps/pi-extension/src/turn-tool-policy.ts",
  "apps/pi-extension/src/code-tool-presentation.ts",
  "apps/pi-extension/src/execution-outcome.ts",
  "apps/pi-extension/src/approval-presentation.ts",
  "apps/pi-extension/src/status-presentation.ts",
  "apps/pi-extension/src/validation-tool.ts",
  "apps/pi-extension/src/workflow-tools.ts",
  "packages/core/src/code/service-support.ts",
  "packages/core/src/code/service-types.ts",
  "packages/core/src/ledger/schema.ts",
  "packages/core/src/ledger/ledger-records.ts",
  "packages/core/src/state/working-state-markdown.ts",
  "scripts/live-acceptance.sh",
  "docs/ADR-0030-REPOSITORY-FINALIZATION-AND-CLOSURE-SEMANTICS.md",
]) {
  check(text(path).trim().length > 0, `${path} is missing or empty`);
}

check(text("docs/REVIEW_CORRECTIONS.md").includes("Recommendation 29"), "review-correction traceability is incomplete");
check(text("docs/MANUAL_ACCEPTANCE_CORRECTIONS.md").includes("Confirmed product defects"), "manual-acceptance correction traceability is incomplete");

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`release metadata: ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Release metadata consistent for Atelier ${ATELIER_VERSION}; ${adrFiles.length} ADR identifiers are unique.\n`);
}
