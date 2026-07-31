import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  runInteractiveProcess,
  type InteractiveProcessResult,
} from "../../../packages/core/src/index.ts";

const EMPTY_COMPONENT = {
  render: (): string[] => [],
  invalidate: (): void => {},
};

/**
 * Suspend Pi's TUI while an interactive child owns the terminal.
 *
 * Launching Helix, Yazi, or another full-screen program while Pi remains in
 * raw/alternate-screen mode leaves the child blank or unresponsive. The TUI
 * must release the terminal before spawn and reclaim it only after the child
 * has exited.
 */
export async function runInteractiveProcessWithPi(
  ctx: ExtensionContext,
  options: {
    command: string;
    args?: string[];
    cwd: string;
    environment?: NodeJS.ProcessEnv | undefined;
    signal?: AbortSignal | undefined;
    purpose: string;
  },
): Promise<InteractiveProcessResult> {
  if (ctx.mode !== "tui") {
    throw new Error(`${options.purpose} requires Pi TUI mode.`);
  }

  return await ctx.ui.custom<InteractiveProcessResult>((tui, _theme, _keybindings, done) => {
    let restored = false;
    const restore = (): void => {
      if (restored) return;
      restored = true;
      tui.start();
      tui.requestRender(true);
    };

    tui.stop();
    void (async () => {
      let result: InteractiveProcessResult;
      try {
        result = await runInteractiveProcess({
          command: options.command,
          ...(options.args === undefined ? {} : { args: options.args }),
          cwd: options.cwd,
          ...(options.environment === undefined ? {} : { environment: options.environment }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        result = {
          command: options.command,
          args: options.args ?? [],
          exitCode: 1,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      restore();
      done(result);
    })();

    return EMPTY_COMPONENT;
  });
}
