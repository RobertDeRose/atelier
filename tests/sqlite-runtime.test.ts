import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDatabaseSync, type SqliteDatabase } from "../packages/core/src/index.ts";

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

    const runtimeSource = readFileSync(new URL("../packages/core/src/ledger/sqlite-runtime.ts", import.meta.url), "utf8");
    const ledgerSource = readFileSync(new URL("../packages/core/src/ledger/sqlite-ledger.ts", import.meta.url), "utf8");
    const validationSource = readFileSync(new URL("../packages/core/src/validation/validation-service.ts", import.meta.url), "utf8");
    assert.doesNotMatch(runtimeSource, /from ["'](?:node|bun):sqlite["']/);
    assert.doesNotMatch(ledgerSource, /from ["'](?:node|bun):sqlite["']/);
    assert.doesNotMatch(validationSource, /from ["'](?:node|bun):sqlite["']/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite selects bun:sqlite when Pi runs the extension inside Bun", () => {
  const calls: string[] = [];
  class FakeBunDatabase implements SqliteDatabase {
    readonly path: string;
    constructor(path: string) {
      this.path = path;
    }
    exec(_sql: string): void {}
    prepare(_sql: string) {
      return {
        run: (..._params: unknown[]) => ({ changes: 0 }),
        get: (..._params: unknown[]) => undefined,
        all: (..._params: unknown[]) => [],
      };
    }
    close(): void {}
  }

  const Database = loadDatabaseSync({
    preferBun: true,
    runtimeDescription: "test Bun runtime",
    getBuiltinModule: () => undefined,
    requireModule: (specifier) => {
      calls.push(specifier);
      if (specifier === "bun:sqlite") return { Database: FakeBunDatabase };
      throw new Error(`unexpected module ${specifier}`);
    },
  });

  const database = new Database("state.db") as FakeBunDatabase;
  assert.equal(database.path, "state.db");
  assert.deepEqual(calls, ["bun:sqlite"]);
});

test("SQLite falls back to node:sqlite when Bun's module is unavailable", () => {
  class FakeNodeDatabase implements SqliteDatabase {
    readonly path: string;
    constructor(path: string) {
      this.path = path;
    }
    exec(_sql: string): void {}
    prepare(_sql: string) {
      return {
        run: (..._params: unknown[]) => ({ changes: 0 }),
        get: (..._params: unknown[]) => undefined,
        all: (..._params: unknown[]) => [],
      };
    }
    close(): void {}
  }

  const calls: string[] = [];
  const Database = loadDatabaseSync({
    preferBun: true,
    runtimeDescription: "test fallback runtime",
    getBuiltinModule: (specifier) => {
      calls.push(specifier);
      return specifier === "node:sqlite" ? { DatabaseSync: FakeNodeDatabase } : undefined;
    },
    requireModule: (specifier) => {
      calls.push(specifier);
      throw new Error(`missing ${specifier}`);
    },
  });

  const database = new Database("fallback.db") as FakeNodeDatabase;
  assert.equal(database.path, "fallback.db");
  assert.deepEqual(calls, ["bun:sqlite", "bun:sqlite", "node:sqlite"]);
});
