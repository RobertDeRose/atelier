import { sourceRevisionIdentity } from "../repository/snapshot.ts";
import type { CodeProviderStatus, CodeWorkspace } from "./types.ts";

interface CachedProviderStatus {
  status: CodeProviderStatus;
  workspaceDigest: string;
  observedAt: number;
}

export class CodeProviderStatusCache {
  private readonly cached = new Map<string, CachedProviderStatus>();
  private readonly pending = new Map<string, Promise<CodeProviderStatus>>();

  private workspaceDigest(workspace?: CodeWorkspace): string {
    if (workspace === undefined) return "none";
    return workspace.repositories
      .map((repository) => `${repository.id}:${sourceRevisionIdentity(repository.snapshot)}`)
      .sort()
      .join("\n");
  }

  peek(provider: string, workspace?: CodeWorkspace): CodeProviderStatus | undefined {
    const cached = this.cached.get(provider);
    if (cached === undefined || cached.workspaceDigest !== this.workspaceDigest(workspace)) return undefined;
    return cached.status;
  }

  invalidate(provider?: string): void {
    if (provider === undefined) this.cached.clear();
    else this.cached.delete(provider);
  }

  async get(
    provider: string,
    workspace: CodeWorkspace | undefined,
    load: () => Promise<CodeProviderStatus>,
    options: { force?: boolean; maxAgeMs?: number } = {},
  ): Promise<CodeProviderStatus> {
    const workspaceDigest = this.workspaceDigest(workspace);
    const cached = this.cached.get(provider);
    if (options.force !== true && cached !== undefined
      && cached.workspaceDigest === workspaceDigest
      && Date.now() - cached.observedAt <= (options.maxAgeMs ?? 2_000)) return cached.status;

    const key = `${provider}\0${workspaceDigest}`;
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing;
    const pending = load();
    this.pending.set(key, pending);
    try {
      const status = await pending;
      this.cached.set(provider, { status, workspaceDigest, observedAt: Date.now() });
      return status;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }
}
