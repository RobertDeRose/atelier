import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AtelierCore, ManualEditEditor } from "../../../packages/core/src/index.ts";
import { runInteractiveProcessWithPi } from "./interactive-process.ts";

export async function runPlanEditorWithPi(
  ctx: ExtensionContext,
  core: AtelierCore,
  editor: ManualEditEditor,
): Promise<{ exitCode: number; error?: string; signal?: string; editor: ManualEditEditor }> {
  if (ctx.mode !== "tui") {
    throw new Error(`ManualEdit requires Pi TUI mode to open ${core.config.planPath}. Run \`atlr review\` in a terminal, then resume this session.`);
  }
  const result = await runInteractiveProcessWithPi(ctx, {
    command: editor.executable,
    args: [...editor.args, core.config.planPath],
    cwd: core.config.repositoryRoot,
    purpose: "ManualEdit",
  });
  return { ...result, editor };
}
