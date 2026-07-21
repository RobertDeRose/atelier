import type { CodeProvider } from "./provider.ts";
import type { CodeProviderStatus, CodeWorkspace } from "./types.ts";

export class CodeProviderRegistry {
  private readonly providers = new Map<string, CodeProvider>();
  readonly defaultProvider: string;

  constructor(providers: CodeProvider[], defaultProvider: string) {
    this.defaultProvider = defaultProvider;
    for (const provider of providers) this.providers.set(provider.name, provider);
  }

  get(name = this.defaultProvider): CodeProvider {
    const provider = this.providers.get(name);
    if (provider === undefined) throw new Error(`Unknown code provider: ${name}`);
    return provider;
  }

  names(): string[] {
    return [...this.providers.keys()].sort();
  }

  async statuses(workspace?: CodeWorkspace): Promise<CodeProviderStatus[]> {
    return Promise.all(this.names().map((name) => this.get(name).status(workspace)));
  }

  async close(): Promise<void> {
    await Promise.all(this.names().map((name) => this.get(name).close()));
  }
}
