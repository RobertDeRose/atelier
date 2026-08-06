import { redactText } from "../security/redaction.ts";
import { sha256 } from "../util/hash.ts";
import { newId, nowIso } from "../util/ids.ts";

export const MAX_COMMIT_FAILURE_ATTEMPTS = 2;
export const MAX_COMMIT_FAILURE_EVIDENCE = 4_096;

export type CommitFailureCategory =
  | "hook_rejection"
  | "signing_failure"
  | "filter_failure"
  | "user_cancellation"
  | "timeout"
  | "unknown";

export type CommitFailureDecision = "pending" | "retry" | "pause" | "cancel" | "bypass";

export interface CommitFailureClassification {
  category: CommitFailureCategory;
  retryable: boolean;
  detail: string;
  remediation: string[];
}

export interface CommitAttemptState {
  version: 1;
  id: string;
  taskId: string;
  executionGrantId: string;
  attempt: number;
  category: CommitFailureCategory;
  retryable: boolean;
  decision: CommitFailureDecision;
  decisionActor?: "user" | "agent";
  decisionAt?: string;
  sourceFingerprint: string;
  configurationFingerprint: string;
  failureFingerprint: string;
  evidence: string;
  remediation: string[];
  occurredAt: string;
}

export class CommitFailureError extends Error {
  readonly state: CommitAttemptState;
  readonly budgetExhausted: boolean;

  constructor(message: string, state: CommitAttemptState, budgetExhausted = false, cause?: unknown) {
    super(message, { cause });
    this.name = "CommitFailureError";
    this.state = state;
    this.budgetExhausted = budgetExhausted;
  }
}

function boundedEvidence(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  const redacted = redactText(value).trim();
  if (redacted.length <= MAX_COMMIT_FAILURE_EVIDENCE) return redacted;
  return `${redacted.slice(0, MAX_COMMIT_FAILURE_EVIDENCE - 20)}\n[truncated]`;
}

export function classifyCommitFailure(error: unknown): CommitFailureClassification {
  const detail = boundedEvidence(error);
  const normalized = detail.toLowerCase();
  if (/timed out|timeout|deadline exceeded/.test(normalized)) {
    return {
      category: "timeout",
      retryable: false,
      detail,
      remediation: [
        "Inspect the timed-out hook or Git process before retrying.",
        "Ask whether to retry after external remediation, pause, or cancel; do not weaken Git policy.",
      ],
    };
  }
  if (/cancel|interrupt|sigint|terminated|aborted/.test(normalized)) {
    return {
      category: "user_cancellation",
      retryable: false,
      detail,
      remediation: [
        "The commit was cancelled before completion; inspect the repository before deciding what to do next.",
        "Ask whether to retry, pause, or cancel. No bypass is selected automatically.",
      ],
    };
  }
  if (/clean filter|smudge|process filter|gitattributes|filter .*fail/.test(normalized)) {
    return {
      category: "filter_failure",
      retryable: true,
      detail,
      remediation: [
        "Inspect the clean/smudge filter output and repository attributes without disabling the filter.",
        "Fix the filter or its input, then retry the same scoped commit once.",
        "If the filter cannot be repaired, pause or cancel; an explicit bypass requires a separate reviewed decision.",
      ],
    };
  }
  if (/gpg|signing|sign .*key|no secret key|pinentry|publickey|ssh key/.test(normalized)) {
    return {
      category: "signing_failure",
      retryable: true,
      detail,
      remediation: [
        "Verify the repository's configured signing key and signing agent without changing signing policy.",
        "Repair the external signing configuration, then retry the same scoped commit once.",
        "If signing remains unavailable, ask whether to retry, pause, cancel, or make an explicit reviewed bypass decision.",
      ],
    };
  }
  if (/hook|pre-commit|commit-msg|pre-push|check failed|rejected the commit|reject/.test(normalized)) {
    return {
      category: "hook_rejection",
      retryable: true,
      detail,
      remediation: [
        "Inspect the hook/check output and fix the reported check without bypassing Git policy.",
        "Retry the same scoped commit once the repository state is corrected.",
        "If the check cannot be repaired, ask whether to retry, pause, cancel, or make an explicit reviewed bypass decision.",
      ],
    };
  }
  return {
    category: "unknown",
    retryable: false,
    detail,
    remediation: [
      "Inspect the bounded Git output and repository state before retrying.",
      "Ask whether to retry after external remediation, pause, or cancel; no enforcement bypass is selected automatically.",
    ],
  };
}

export function commitAttemptState(
  taskId: string,
  executionGrantId: string,
  classification: CommitFailureClassification,
  attempt: number,
  context: { sourceFingerprint: string; configurationFingerprint: string },
): CommitAttemptState {
  return {
    version: 1,
    id: newId("commit-attempt"),
    taskId,
    executionGrantId,
    attempt,
    category: classification.category,
    retryable: classification.retryable,
    decision: "pending",
    sourceFingerprint: context.sourceFingerprint,
    configurationFingerprint: context.configurationFingerprint,
    failureFingerprint: sha256(`${classification.category}\n${classification.detail}`),
    evidence: classification.detail,
    remediation: classification.remediation,
    occurredAt: nowIso(),
  };
}

export function commitFailureMessage(state: CommitAttemptState, budgetExhausted = false): string {
  const prefix = budgetExhausted
    ? `Commit retry budget exhausted after ${state.attempt} identical ${state.category} failures.`
    : `Local commit failed (${state.category}; attempt ${state.attempt}/${MAX_COMMIT_FAILURE_ATTEMPTS}).`;
  return [prefix, `Evidence: ${state.evidence}`, ...state.remediation].join(" ");
}
