import { basename, relative } from "node:path";
import { isPathWithin, resolveAccessPath } from "../security/path-boundary.ts";

export const EFFECT_KINDS = [
  "read",
  "create",
  "mutate",
  "delete",
  "overwrite",
  "execute",
  "network",
  "privilege_escalation",
  "unknown",
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

export const PATH_STATES = [
  "outside_workspace",
  "potential_secret",
  "missing",
  "tracked_clean",
  "tracked_dirty",
  "untracked",
  "ignored",
  "unknown",
] as const;
export type WorkspacePathState = (typeof PATH_STATES)[number];

export interface FilesystemEffect {
  kind: EffectKind;
  path?: string;
  destructive?: boolean;
  preservesPrevious?: boolean;
  description?: string;
}

export type WorkspaceDecisionKind = "allow" | "checkpoint_then_allow" | "ask" | "deny";

export interface EvaluatedEffect extends FilesystemEffect {
  resolvedPath?: string;
  state: WorkspacePathState;
  decision: WorkspaceDecisionKind;
  reason: string;
}

export interface WorkspacePolicyDecision {
  result: WorkspaceDecisionKind;
  effects: EvaluatedEffect[];
  reason: string;
}

const DEFAULT_SECRET_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /(?:^|\/)id_(?:rsa|ed25519)$/i,
  /\.(?:pem|key)$/i,
  /(?:^|\/)(?:credentials|secrets?)(?:[^/]*)$/i,
  /(?:^|\/)\.netrc$/i,
  /(?:^|\/)\.(?:npmrc|pypirc)$/i,
  /(?:^|\/)\.(?:aws|ssh)(?:\/|$)/i,
];

export function isPotentialSecretPath(path: string, workspaceRoot: string, extraPatterns: readonly string[] = []): boolean {
  const rel = relative(workspaceRoot, path).replaceAll("\\", "/");
  const candidate = rel && !rel.startsWith("../") ? rel : path.replaceAll("\\", "/");
  const leaf = basename(candidate);
  return DEFAULT_SECRET_PATTERNS.some((pattern) => pattern.test(candidate) || pattern.test(leaf))
    || extraPatterns.some((pattern) => {
      try { return new RegExp(pattern).test(candidate); } catch { return false; }
    });
}

export interface WorkspaceStateResolver {
  classify(path: string): Exclude<WorkspacePathState, "outside_workspace" | "potential_secret">;
}

function rank(decision: WorkspaceDecisionKind): number {
  return { allow: 0, checkpoint_then_allow: 1, ask: 2, deny: 3 }[decision];
}

export class WorkspacePolicyEvaluator {
  readonly root: string;
  readonly secretPatterns: readonly string[];

  constructor(options: { root: string; secretPatterns?: readonly string[] }) {
    this.root = resolveAccessPath(options.root, "write");
    this.secretPatterns = options.secretPatterns ?? [];
  }

  evaluate(effects: readonly FilesystemEffect[], resolver: WorkspaceStateResolver): WorkspacePolicyDecision {
    const evaluated = effects.map((effect) => this.evaluateOne(effect, resolver));
    const result = evaluated.reduce<WorkspaceDecisionKind>((current, item) =>
      rank(item.decision) > rank(current) ? item.decision : current, "allow");
    const blocking = evaluated.filter((item) => item.decision === result);
    return {
      result,
      effects: evaluated,
      reason: blocking.map((item) => item.reason).filter((value, index, all) => all.indexOf(value) === index).join(" "),
    };
  }

  private evaluateOne(effect: FilesystemEffect, resolver: WorkspaceStateResolver): EvaluatedEffect {
    if (effect.kind === "privilege_escalation") {
      return { ...effect, state: "unknown", decision: "ask", reason: "Privilege escalation requires one-time user approval." };
    }
    if (effect.path === undefined) {
      if (effect.kind === "read") return { ...effect, state: "unknown", decision: "ask", reason: "The read target could not be determined." };
      if (effect.kind === "execute" || effect.kind === "unknown" || effect.kind === "network") {
        return { ...effect, state: "unknown", decision: "ask", reason: "The operation's persistent effects cannot be bounded to the workspace." };
      }
      return { ...effect, state: "unknown", decision: "ask", reason: "The affected path could not be determined." };
    }

    const resolvedPath = resolveAccessPath(effect.path, effect.kind === "read" ? "read" : "write");
    if (!isPathWithin(resolvedPath, this.root, effect.kind === "read" ? "read" : "write")) {
      return { ...effect, resolvedPath, state: "outside_workspace", decision: "ask", reason: `The operation affects a path outside the Atelier workspace: ${resolvedPath}` };
    }
    if (isPotentialSecretPath(resolvedPath, this.root, this.secretPatterns)) {
      return { ...effect, resolvedPath, state: "potential_secret", decision: "ask", reason: `The operation accesses a likely secret path: ${resolvedPath}` };
    }

    const state = resolver.classify(resolvedPath);
    if (effect.kind === "read") return { ...effect, resolvedPath, state, decision: "allow", reason: "Ordinary workspace read is allowed." };
    if (effect.kind === "create" && state === "missing") return { ...effect, resolvedPath, state, decision: "allow", reason: "Creating a new path inside the workspace is recoverable." };
    if ((effect.kind === "mutate" || effect.kind === "delete" || effect.kind === "overwrite") && state === "tracked_clean") {
      return { ...effect, resolvedPath, state, decision: "allow", reason: "The clean tracked path is recoverable from version control." };
    }
    if ((effect.kind === "mutate" || effect.kind === "delete" || effect.kind === "overwrite") && state === "tracked_dirty") {
      return { ...effect, resolvedPath, state, decision: "checkpoint_then_allow", reason: "The dirty tracked path must be checkpointed before mutation." };
    }
    if (effect.kind === "mutate" && (state === "untracked" || state === "ignored") && effect.preservesPrevious === true) {
      return { ...effect, resolvedPath, state, decision: "allow", reason: "The mutation preserves the existing untracked contents." };
    }
    if ((effect.kind === "mutate" || effect.kind === "overwrite" || effect.kind === "delete") && (state === "untracked" || state === "ignored")) {
      return { ...effect, resolvedPath, state, decision: "checkpoint_then_allow", reason: "The existing untracked or ignored path must be checkpointed before destructive change." };
    }
    if (effect.kind === "create" && state !== "missing") {
      return { ...effect, resolvedPath, state, decision: "ask", reason: `The create operation would replace existing state at ${resolvedPath}.` };
    }
    return { ...effect, resolvedPath, state, decision: "ask", reason: `Atelier cannot guarantee recovery for ${resolvedPath}.` };
  }
}
