import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("atlr launch starts Pi with the Atelier extension and forwards Pi arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-launch-"));
  const bin = join(root, "bin");
  const capture = join(root, "capture.json");
  mkdirSync(bin, { recursive: true });
  const fakePi = join(bin, "pi");
  writeFileSync(
    fakePi,
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.ATELIER_TEST_CAPTURE, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), atelierRoot: process.env.ATELIER_ROOT }));\n`,
    "utf8",
  );
  chmodSync(fakePi, 0o755);

  try {
    const result = spawnSync(
      process.execPath,
      [new URL("../bin/atlr.mjs", import.meta.url).pathname, "--root", root, "launch", "--model", "test-model"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          ATELIER_TEST_CAPTURE: capture,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const recorded = JSON.parse(readFileSync(capture, "utf8")) as {
      cwd: string;
      args: string[];
      atelierRoot: string;
    };
    const canonicalRoot = realpathSync(root);
    assert.equal(recorded.cwd, canonicalRoot);
    assert.equal(recorded.atelierRoot, canonicalRoot);
    assert.equal(recorded.args[0], "--extension");
    assert.match(recorded.args[1] ?? "", /apps\/pi-extension\/src\/index\.ts$/);
    assert.deepEqual(recorded.args.slice(2), ["--model", "test-model"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
