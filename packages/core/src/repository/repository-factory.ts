import type { AtelierConfig } from "../config/config.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import { GitRepositoryProvider } from "./git-repository-provider.ts";
import { JujutsuRepositoryProvider } from "./jujutsu-repository-provider.ts";
import type { RepositoryProvider } from "./repository-provider.ts";

export function createRepositoryProvider(config: AtelierConfig, ledger: SqliteLedger): RepositoryProvider {
  const jj = new JujutsuRepositoryProvider({
    cwd: config.repositoryRoot,
    ledger,
    executable: config.jjCommand,
    indexSchemaVersion: config.indexSchemaVersion,
  });
  const git = new GitRepositoryProvider({ cwd: config.repositoryRoot, ledger, indexSchemaVersion: config.indexSchemaVersion });

  if (config.repositoryProvider === "jj") return jj;
  if (config.repositoryProvider === "git") return git;

  const jjStatus = jj.status();
  if (jjStatus.available && jjStatus.repository) return jj;
  const gitStatus = git.status();
  if (gitStatus.available && gitStatus.repository) return git;
  return jjStatus.available ? jj : git;
}
