import { sha256 } from "../../../packages/core/src/index.ts";

export interface AuthoritativeContextCapsule {
  digest: string;
  markdown: string;
}

export function createAuthoritativeContextCapsule(input: {
  modeInstruction: string;
  turnPolicyInstruction?: string;
  workingStateMarkdown: string;
}): AuthoritativeContextCapsule {
  const markdown = [
    "## Atelier authoritative context",
    "",
    "Conversation history and compaction summaries are non-authoritative. The state below is reconstructed from the durable ledger, current repository, reviewed plan, task provider, reviewed task constraints, and validation evidence for this turn.",
    "",
    input.modeInstruction.trim(),
    input.turnPolicyInstruction?.trim() ?? "",
    "",
    input.workingStateMarkdown.trim(),
  ].filter((line, index, lines) => line.length > 0 || lines[index - 1]?.length !== 0).join("\n").trim();
  return { digest: sha256(markdown), markdown };
}

export function contextCapsulePrompt(baseSystemPrompt: string, capsule: AuthoritativeContextCapsule): string {
  return `${baseSystemPrompt}\n\n${capsule.markdown}\n\nAtelier context digest: ${capsule.digest}`;
}
