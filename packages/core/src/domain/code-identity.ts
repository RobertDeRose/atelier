export type CodeFreshness = "current" | "possibly_stale" | "known_stale" | "unknown";

export interface CodeProviderIdentity {
  name: string;
  version?: string;
  instanceId: string;
}
