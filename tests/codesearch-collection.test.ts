import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("codesearch collection preserves failed conformance evidence and still creates fixtures and an archive", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-code-collect-"));
  const out = join(root, ".atelier", "codesearch-probe");
  const archive = join(root, "knowledge.tar.xz");
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "probe-codesearch.sh"), `#!/usr/bin/env bash\nset -eu\nout=$2\nmkdir -p "$out"\nprintf '{"totals":{"passed":1,"warnings":0,"failed":1}}\\n' > "$out/conformance.stdout"\nprintf '# Codesearch Conformance\\n\\n- Passed: 1\\n- Warnings: 0\\n- Failed: 1\\n' > "$out/CONFORMANCE.md"\nprintf '1\\n' > "$out/conformance.status"\nprintf '[]\\n' > "$out/search.stdout"\nexit 1\n`);
    chmodSync(join(root, "scripts", "probe-codesearch.sh"), 0o755);
    writeFileSync(join(root, "scripts", "update-codesearch-fixtures.ts"), `import { mkdirSync, writeFileSync } from "node:fs"; const out=process.argv[3]; mkdirSync(out,{recursive:true}); writeFileSync(out+"/manifest.json","{}\\n");`);

    const result = spawnSync("bash", [
      resolve("scripts/collect-codesearch-knowledge.sh"),
      root,
      out,
      archive,
    ], { encoding: "utf8" });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.ok(existsSync(join(out, "normalized-fixtures", "manifest.json")));
    assert.ok(existsSync(archive));
    assert.match(result.stdout, /Knowledge archive ready at:/);
    assert.match(result.stderr, /complete evidence archive was still created/);
    assert.match(readFileSync(join(out, "CONFORMANCE.md"), "utf8"), /Failed: 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
