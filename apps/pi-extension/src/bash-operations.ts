import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { runSandboxedShell, type SandboxBackend } from "../../../packages/core/src/index.ts";

export function createAtelierBashOperations(options: {
  workspace: string;
  backend: SandboxBackend;
  allowNetwork?: boolean;
  allowUnsandboxed: boolean;
}): BashOperations {
  return {
    async exec(command, cwd, execution) {
      const result = await runSandboxedShell({
        workspace: options.workspace,
        command,
        cwd,
        backend: options.backend,
        allowNetwork: options.allowNetwork ?? false,
        allowUnsandboxed: options.allowUnsandboxed,
        ...(execution.signal === undefined ? {} : { signal: execution.signal }),
        ...(execution.timeout === undefined ? {} : { timeoutMs: execution.timeout * 1000 }),
        // Pi's BashOperations contract requires Buffer chunks. Passing the
        // core runner's UTF-8 strings works for silent commands, but crashes
        // Pi's interactive `!` command renderer as soon as output arrives.
        onData: (chunk) => execution.onData(Buffer.from(chunk, "utf8")),
      });
      if (result.aborted) throw new Error("aborted");
      if (result.timedOut) throw new Error(`timeout:${execution.timeout ?? 0}`);
      return { exitCode: result.exitCode };
    },
  };
}
