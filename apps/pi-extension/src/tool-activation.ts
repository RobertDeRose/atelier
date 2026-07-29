import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AtelierCore } from "../../../packages/core/src/index.ts";

export function ensureAtelierToolsActive(
  pi: ExtensionAPI,
  core: AtelierCore,
  workflowTools: readonly string[],
  retrievalTools: readonly string[],
): void {
  const active = pi.getActiveTools();
  const retrieval = core.config.codeProvider === "disabled" ? [] : [...retrievalTools];
  pi.setActiveTools([...new Set([...retrieval, ...workflowTools, ...active])]);
}

export function isBroadRawDiscovery(event: any): boolean {
  if (["grep", "find", "ls"].includes(event.toolName)) return true;
  if (event.toolName !== "bash" || typeof event.input?.command !== "string") return false;
  return /(^|[;&|\n]\s*)(?:rg|grep|find|fd|tree|ls)(?:\s|$)/.test(event.input.command.trim());
}
