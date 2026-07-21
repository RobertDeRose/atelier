import type { CodeProvider } from "./provider.ts";
import type { CodeChunk, CodeIndexState, CodeProviderStatus, CodeRelationship, CodeRelationshipQuery, CodeSearchHit, CodeSearchQuery, CodeSymbolQuery, CodeWorkspace } from "./types.ts";

export class DisabledCodeProvider implements CodeProvider {
  readonly name = "disabled";
  async status(): Promise<CodeProviderStatus> {
    return {
      identity: { name: this.name, instanceId: "disabled" },
      available: false,
      healthy: false,
      capabilities: [],
      indexState: "unknown",
      detail: "Code intelligence is disabled or no provider is configured.",
    };
  }
  async ensureIndex(_workspace: CodeWorkspace): Promise<CodeIndexState> { return "unknown"; }
  async search(_query: CodeSearchQuery): Promise<CodeSearchHit[]> { return []; }
  async read(_reference: CodeSearchHit["reference"]): Promise<CodeChunk> { throw new Error("Code intelligence is disabled."); }
  async symbols(_query: CodeSymbolQuery): Promise<CodeSearchHit[]> { return []; }
  async relationships(_query: CodeRelationshipQuery): Promise<CodeRelationship[]> { return []; }
  async close(): Promise<void> {}
}
