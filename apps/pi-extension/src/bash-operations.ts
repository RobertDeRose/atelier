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
        onData: (chunk) => execution.onData(chunk),
      });
      if (result.aborted) throw new Error("aborted");
      if (result.timedOut) throw new Error(`timeout:${execution.timeout ?? 0}`);
      return { exitCode: result.exitCode };
    },
  };
}
