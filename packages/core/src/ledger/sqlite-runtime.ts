import { createRequire } from "node:module";

export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid?: number | bigint;
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteDatabaseConstructor {
  new (path: string): SqliteDatabase;
}

interface NodeSqliteModule {
  DatabaseSync?: SqliteDatabaseConstructor;
}

interface BunSqliteModule {
  Database?: SqliteDatabaseConstructor;
}

function normalizeBunDatabaseConstructor(
  Database: SqliteDatabaseConstructor,
): SqliteDatabaseConstructor {
  return class NormalizedBunDatabase implements SqliteDatabase {
    readonly #database: SqliteDatabase;

    constructor(path: string) {
      this.#database = new Database(path);
    }

    exec(sql: string): void {
      this.#database.exec(sql);
    }

    prepare(sql: string): SqliteStatement {
      const statement = this.#database.prepare(sql);
      return {
        run: (...params: unknown[]) => statement.run(...params),
        get: (...params: unknown[]) => statement.get(...params) ?? undefined,
        all: (...params: unknown[]) => statement.all(...params),
      };
    }

    close(): void {
      this.#database.close();
    }
  };
}

export interface SqliteRuntimeOptions {
  getBuiltinModule?: (specifier: string) => unknown;
  requireModule?: (specifier: string) => unknown;
  preferBun?: boolean;
  runtimeDescription?: string;
}

const runtimeRequire = createRequire(import.meta.url);

function bunRuntimeDetected(): boolean {
  const versions = process.versions as NodeJS.ProcessVersions & { bun?: string };
  return typeof versions.bun === "string" || "Bun" in globalThis;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve a synchronous SQLite constructor for the active shell runtime.
 *
 * Atelier's CLI runs under Node and uses `node:sqlite`. Pi is distributed as a
 * Bun executable and loads extensions inside Bun, where the matching built-in
 * is `bun:sqlite`. Both implementations provide the small synchronous database
 * surface used by SqliteLedger, so the runtime boundary selects one without a
 * static import that Pi's extension loader would try to resolve eagerly.
 */
export function loadDatabaseSync(options: SqliteRuntimeOptions = {}): SqliteDatabaseConstructor {
  const getBuiltinModule = options.getBuiltinModule ?? process.getBuiltinModule;
  const requireModule = options.requireModule ?? runtimeRequire;
  const preferBun = options.preferBun ?? bunRuntimeDetected();
  const runtimeDescription = options.runtimeDescription ??
    (bunRuntimeDetected()
      ? `Bun ${String((process.versions as NodeJS.ProcessVersions & { bun?: string }).bun ?? "runtime")}`
      : `Node ${process.version}`);
  const failures: string[] = [];

  const loadBun = (): SqliteDatabaseConstructor | undefined => {
    if (typeof getBuiltinModule === "function") {
      try {
        const module = getBuiltinModule("bun:sqlite") as BunSqliteModule | undefined;
        if (typeof module?.Database === "function") return normalizeBunDatabaseConstructor(module.Database);
      } catch (error) {
        failures.push(`bun:sqlite via process.getBuiltinModule: ${errorDetail(error)}`);
      }
    }

    try {
      const module = requireModule("bun:sqlite") as BunSqliteModule | undefined;
      if (typeof module?.Database === "function") return normalizeBunDatabaseConstructor(module.Database);
      failures.push("bun:sqlite did not expose Database");
    } catch (error) {
      failures.push(`bun:sqlite via require: ${errorDetail(error)}`);
    }
    return undefined;
  };

  const loadNode = (): SqliteDatabaseConstructor | undefined => {
    if (typeof getBuiltinModule === "function") {
      try {
        const module = getBuiltinModule("node:sqlite") as NodeSqliteModule | undefined;
        if (typeof module?.DatabaseSync === "function") return module.DatabaseSync;
        failures.push("node:sqlite did not expose DatabaseSync");
      } catch (error) {
        failures.push(`node:sqlite via process.getBuiltinModule: ${errorDetail(error)}`);
      }
    }

    try {
      const module = requireModule("node:sqlite") as NodeSqliteModule | undefined;
      if (typeof module?.DatabaseSync === "function") return module.DatabaseSync;
      failures.push("required node:sqlite did not expose DatabaseSync");
    } catch (error) {
      failures.push(`node:sqlite via require: ${errorDetail(error)}`);
    }
    return undefined;
  };

  const orderedLoaders = preferBun ? [loadBun, loadNode] : [loadNode, loadBun];
  for (const loader of orderedLoaders) {
    const constructor = loader();
    if (constructor !== undefined) return constructor;
  }

  throw new Error(
    `Atelier could not load a synchronous SQLite implementation in ${runtimeDescription}. ` +
      `Tried node:sqlite and bun:sqlite. ${failures.join("; ")}`,
  );
}
