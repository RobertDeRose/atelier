declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionUIContext {
    confirm(title: string, message: string): Promise<boolean>;
    select(title: string, options: string[]): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
    custom<T>(
      factory: (
        tui: {
          stop(): void;
          start(): void;
          requestRender(force?: boolean): void;
        },
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => {
        render(width: number): string[];
        invalidate(): void;
        dispose?(): void;
      },
    ): Promise<T>;
  }

  export interface ExtensionContext {
    ui: ExtensionUIContext;
    mode: "tui" | "rpc" | "json" | "print";
    hasUI: boolean;
    cwd: string;
    isIdle(): boolean;
    isProjectTrusted(): boolean;
  }

  export interface ExtensionCommandContext extends ExtensionContext {
    waitForIdle(): Promise<void>;
  }

  export interface ExtensionAPI {
    getActiveTools(): string[];
    setActiveTools(toolNames: string[]): void;
    on(
      event: string,
      handler: (event: any, ctx: ExtensionContext) => Promise<any> | any,
    ): void;
    registerCommand(
      name: string,
      options: {
        description?: string;
        handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
      },
    ): void;
    registerTool(definition: {
      name: string;
      label: string;
      description: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters: unknown;
      execute(
        toolCallId: string,
        params: any,
        signal: AbortSignal,
        onUpdate: ((update: unknown) => void) | undefined,
        ctx: ExtensionContext,
      ): Promise<{
        content: Array<{ type: "text"; text: string }>;
        details?: unknown;
      }>;
    }): void;
    sendUserMessage(
      content: string,
      options?: { deliverAs?: "steer" | "followUp" },
    ): void;
  }
}
