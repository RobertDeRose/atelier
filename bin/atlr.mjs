#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entryUrl = new URL("../dist/apps/cli/src/main.js", import.meta.url);
const entry = fileURLToPath(entryUrl);
if (!existsSync(entry)) {
  process.stderr.write("atlr: built CLI is missing; run `npm run build` before using the package launcher.\n");
  process.exitCode = 1;
} else {
  await import(entryUrl.href);
}
