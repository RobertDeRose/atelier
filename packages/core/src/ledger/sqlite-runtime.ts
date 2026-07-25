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

interface DatabaseSyncConstructor {
  new (path: string): SqliteDatabase;
}

interface NodeSqliteModule {
  DatabaseSync?: DatabaseSyncConstructor;
}

/**
 * Resolve node:sqlite at runtime instead of importing it statically.
 *
 * Pi loads TypeScript extensions through jiti. Some loader/runtime combinations
 * reject newer built-ins during static resolution even when the Node process
 * itself provides them. process.getBuiltinModule bypasses that resolver while
 * retaining Node's built-in synchronous SQLite implementation.
 */
export function loadDatabaseSync(): DatabaseSyncConstructor {
  const getBuiltinModule = process.getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    throw new Error(
      `Atelier requires Node.js with process.getBuiltinModule and node:sqlite; current runtime is ${process.version}. ` +
        "Launch Atelier through `mise run launch` so Pi uses the repository's pinned Node runtime.",
    );
  }

  let module: NodeSqliteModule | undefined;
  try {
    module = getBuiltinModule("node:sqlite") as NodeSqliteModule | undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Atelier could not load node:sqlite from ${process.version}: ${detail}. ` +
        "Launch Atelier through `mise run launch` so Pi uses the repository's pinned Node runtime.",
    );
  }

  if (typeof module?.DatabaseSync !== "function") {
    throw new Error(
      `Atelier requires node:sqlite DatabaseSync; it is unavailable in ${process.version}. ` +
        "Launch Atelier through `mise run launch` so Pi uses the repository's pinned Node runtime.",
    );
  }
  return module.DatabaseSync;
}
