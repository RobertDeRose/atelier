import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDatabaseSync } from "../packages/core/src/index.ts";

test("SQLite resolves dynamically without a static node:sqlite import", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-sqlite-runtime-"));
  try {
    const DatabaseSync = loadDatabaseSync();
    const database = new DatabaseSync(join(root, "state.db"));
    database.exec("CREATE TABLE sample(value TEXT NOT NULL)");
    database.prepare("INSERT INTO sample(value) VALUES (?)").run("ready");
    const row = database.prepare("SELECT value FROM sample").get() as { value: string };
    assert.equal(row.value, "ready");
    database.close();

    const ledgerSource = readFileSync(new URL("../packages/core/src/ledger/sqlite-ledger.ts", import.meta.url), "utf8");
    const validationSource = readFileSync(new URL("../packages/core/src/validation/validation-service.ts", import.meta.url), "utf8");
    assert.doesNotMatch(ledgerSource, /from ["']node:sqlite["']/);
    assert.doesNotMatch(validationSource, /from ["']node:sqlite["']/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
