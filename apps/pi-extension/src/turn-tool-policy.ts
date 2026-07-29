export interface TurnToolPolicy {
  denyBash: boolean;
  denyValidation: boolean;
  denyCommit: boolean;
  denyClose: boolean;
  stopAfterTurn: boolean;
  sourceText: string;
}

export function eventInputText(event: any): string | undefined {
  for (const value of [event?.text, event?.input, event?.message, event?.content]) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function explicitDenial(text: string, target: RegExp): boolean {
  return new RegExp(`(?:do not|don't|never|without|no)\\s+(?:use\\s+|run\\s+|invoke\\s+)?${target.source}`, "i").test(text);
}

export function turnToolPolicy(text: string): TurnToolPolicy | undefined {
  const policy: TurnToolPolicy = {
    denyBash: explicitDenial(text, /(?:bash|shell)/),
    denyValidation: explicitDenial(text, /(?:validation|validations|tests?|test suite)/),
    denyCommit: explicitDenial(text, /(?:commit|jj change|local change)/),
    denyClose: explicitDenial(text, /(?:close|task closure|finish the task)/),
    stopAfterTurn: /(?:then|and)\s+stop\b|\bstop after\b|\bdo not continue\b/i.test(text),
    sourceText: text,
  };
  return policy.denyBash || policy.denyValidation || policy.denyCommit || policy.denyClose || policy.stopAfterTurn
    ? policy
    : undefined;
}

export function turnPolicyBlockReason(toolName: string, policy: TurnToolPolicy | undefined): string | undefined {
  if (policy === undefined) return undefined;
  if (policy.denyBash && toolName === "bash") return "The current user turn explicitly prohibits Bash or shell use.";
  if (policy.denyValidation && toolName === "atlr_validate") return "The current user turn explicitly prohibits validation or tests.";
  if (policy.denyCommit && toolName === "atlr_commit") return "The current user turn explicitly prohibits creating a commit or local change.";
  if (policy.denyClose && toolName === "atlr_task_close") return "The current user turn explicitly prohibits closing the task.";
  return undefined;
}

export function turnPolicyInstruction(policy: TurnToolPolicy | undefined): string {
  if (policy === undefined) return "";
  const prohibited = [
    policy.denyBash ? "Bash/shell" : undefined,
    policy.denyValidation ? "validation/tests" : undefined,
    policy.denyCommit ? "commit/local change" : undefined,
    policy.denyClose ? "task closure" : undefined,
  ].filter((item): item is string => item !== undefined);
  const clauses = [
    prohibited.length === 0 ? undefined : `Prohibited: ${prohibited.join(", ")}.`,
    policy.stopAfterTurn ? "Stop after the requested operation and do not continue autonomously." : undefined,
    "These user constraints override completion guidance.",
  ].filter((item): item is string => item !== undefined);
  return `\n\n[Atelier current-turn hard policy] ${clauses.join(" ")}`;
}
