import type { BashResult, UserBashEventResult } from "@earendil-works/pi-coding-agent";

/**
 * Convert an Atelier denial into Pi's direct-user-shell replacement contract.
 *
 * `tool_call` handlers can return `{ block, reason }`, but `user_bash` handlers
 * must return either custom operations or a complete BashResult. Returning the
 * tool-call shape makes Pi fall through to its default shell executor.
 */
export function deniedUserBashResult(reason: string | undefined): UserBashEventResult {
  const detail = reason?.trim() || "Atelier denied this command.";
  const result: BashResult = {
    output: `DENIED BY ATELIER\nThe command was not executed.\nReason: ${detail}\n`,
    exitCode: 126,
    cancelled: false,
    truncated: false,
  };
  return { result };
}
