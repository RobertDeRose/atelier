declare module "@earendil-works/pi-coding-agent" {

  export interface BashOperations {
    exec(
      command: string,
      cwd: string,
      options: {
        onData: (chunk: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
      },
    ): Promise<{ exitCode: number | null }>;
  }

  export interface BashToolDefinition {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    execute(
      toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: ((update: unknown) => void) | undefined,
      ctx?: ExtensionContext,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean }>;
  }


  export function createBashTool(
    cwd: string,
    options?: { operations?: BashOperations },
  ): BashToolDefinition;

  export interface ExtensionUIContext {
    confirm(title: string, message: string): Promise<boolean>;
    select(title: string, options: string[]): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
    setWidget?(
      key: string,
      content: string[] | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ): void;
    setFooter?(
      factory: ((
        tui: unknown,
        theme: unknown,
        footerData: unknown,
      ) => { render(width: number): string[]; invalidate(): void; dispose?(): void }) | undefined,
    ): void;
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
        handleInput?(input: unknown): void;
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
    readonly model?: { id?: string; name?: string };
    getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  }

  export interface ExtensionCommandContext extends ExtensionContext {
    waitForIdle(): Promise<void>;
  }

  export interface ExtensionAPI {
    getThinkingLevel?(): string;
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
    registerEntryRenderer?<T = unknown>(
      customType: string,
      renderer: (
        entry: { type: "custom"; customType: string; data?: T },
        options: { expanded: boolean },
        theme: unknown,
      ) => { render(width: number): string[]; invalidate(): void } | undefined,
    ): void;
    appendEntry?<T = unknown>(customType: string, data?: T): void;
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
        signal: AbortSignal | undefined,
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


declare module "@earendil-works/pi-tui" {
  export class Markdown {
    constructor(content: string, paddingX: number, paddingY: number, theme: unknown);
    render(width: number): string[];
    invalidate(): void;
  }
}
