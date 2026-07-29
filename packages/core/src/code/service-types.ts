import type { CodeIndexState } from "./types.ts";

export interface CodeIndexCoordinatorStatus {
  state: CodeIndexState;
  active: boolean;
  provider?: string;
  workspaceId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface CodeServiceLimits {
  maxResults: number;
  maxPreviewBytes: number;
  maxChunkBytes: number;
  maxFetches: number;
  maxTotalBytes: number;
  maxProviderRequests: number;
  maxUniquePaths: number;
  maxEvidenceEntries: number;
}
