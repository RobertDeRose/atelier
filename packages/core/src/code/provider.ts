import type {
  CodeCapability,
  CodeChunk,
  CodeIndexState,
  CodeProviderStatus,
  CodeRelationship,
  CodeRelationshipQuery,
  CodeSearchHit,
  CodeSearchQuery,
  CodeSymbolQuery,
  CodeWorkspace,
} from "./types.ts";

export class UnsupportedCodeCapabilityError extends Error {
  readonly capability: CodeCapability;
  constructor(capability: CodeCapability, provider: string) {
    super(`Code provider ${provider} does not support ${capability}.`);
    this.capability = capability;
    this.name = "UnsupportedCodeCapabilityError";
  }
}

export interface CodeProvider {
  readonly name: string;
  status(workspace?: CodeWorkspace): Promise<CodeProviderStatus>;
  ensureIndex(workspace: CodeWorkspace): Promise<CodeIndexState>;
  search(query: CodeSearchQuery): Promise<CodeSearchHit[]>;
  read(reference: CodeSearchHit["reference"]): Promise<CodeChunk>;
  symbols(query: CodeSymbolQuery): Promise<CodeSearchHit[]>;
  relationships(query: CodeRelationshipQuery): Promise<CodeRelationship[]>;
  close(): Promise<void>;
}
