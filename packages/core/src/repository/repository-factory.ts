import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AtelierConfig } from "../config/config.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import { DirectoryRepositoryProvider } from "./directory-repository-provider.ts";
import { GitRepositoryProvider } from "./git-repository-provider.ts";
import { JujutsuRepositoryProvider } from "./jujutsu-repository-provider.ts";
import type { RepositoryProvider } from "./repository-provider.ts";

function detectedProvider(start: string): "jj" | "git" | "none" {
  let current = resolve(start);
  for (;;) {
    // A colocated Jujutsu repository contains both .jj and .git. Prefer the
    // Jujutsu provider without starting either executable on the Pi startup
    // path. Marker detection is immutable for the lifetime of one Core.
    if (existsSync(resolve(current, ".jj"))) return "jj";
    if (existsSync(resolve(current, ".git"))) return "git";
    const parent = dirname(current);
    if (parent === current) return "none";
    current = parent;
  }
}

export function createRepositoryProvider(
  config: AtelierConfig,
  ledger: SqliteLedger,
  repositoryRoot = config.repositoryRoot,
): RepositoryProvider {
  const selected = config.repositoryProvider === "auto"
    ? detectedProvider(repositoryRoot)
    : config.repositoryProvider;

  if (selected === "jj") {
    return new JujutsuRepositoryProvider({
      cwd: repositoryRoot,
      ledger,
      executable: config.jjCommand,
      indexSchemaVersion: config.indexSchemaVersion,
    });
  }
  if (selected === "git") {
    return new GitRepositoryProvider({
      cwd: repositoryRoot,
      ledger,
      indexSchemaVersion: config.indexSchemaVersion,
    });
  }
  return new DirectoryRepositoryProvider({
    root: repositoryRoot,
    indexSchemaVersion: config.indexSchemaVersion,
    reason: "No supported repository marker was detected.",
  });
}
