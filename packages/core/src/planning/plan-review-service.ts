import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type {
  Actor,
  ManualEdit,
  ManualEditEditor,
  ManualEditStatus,
  PlanDiagnostic,
  RepositorySnapshot,
  WorkflowRun,
} from "../domain/types.ts";
import type { SqliteLedger } from "../ledger/sqlite-ledger.ts";
import type { RepositoryProvider } from "../repository/repository-provider.ts";
import { sha256 } from "../util/hash.ts";
import { newId, nowIso } from "../util/ids.ts";
import { ensurePlanDocument } from "./plan-document.ts";
import { formatPlanTaskMetadataText } from "./plan-metadata.ts";
import { parsePlanText } from "./plan-parser.ts";
import { canonicalRepositoryRoot, repositoryPathTarget, repositoryRelativePath } from "../repository/repository-path.ts";
import { resolveAccessPath } from "../security/path-boundary.ts";
import {
  createPlanStructureSnapshot,
  diffPlanStructures,
} from "./structural-plan-diff.ts";

interface SourceState {
  fingerprint: string;
  paths: string[];
}

export interface BeginPlanReviewOptions {
  actor?: Actor;
  editor?: ManualEditEditor;
}

export interface CompletePlanReviewOptions {
  actor?: Actor;
  exitCode?: number;
  signal?: string;
  error?: string;
  editor?: ManualEditEditor;
}

export interface CancelPlanReviewOptions extends CompletePlanReviewOptions {
  status: Extract<ManualEditStatus, "interrupted" | "failed">;
}

export class PlanReviewService {
  private readonly repositoryRoot: string;
  private readonly planPath: string;
  private readonly stateDirectory: string;
  private readonly ledger: SqliteLedger;
  private readonly repository: RepositoryProvider;

  constructor(options: {
    repositoryRoot: string;
    planPath: string;
    stateDirectory: string;
    ledger: SqliteLedger;
    repository: RepositoryProvider;
  }) {
    this.repositoryRoot = canonicalRepositoryRoot(options.repositoryRoot);
    this.planPath = repositoryPathTarget(this.repositoryRoot, options.planPath, "write").entry;
    this.stateDirectory = resolveAccessPath(options.stateDirectory, "write");
    this.ledger = options.ledger;
    this.repository = options.repository;
  }

  startWorkflow(
    objective: string,
    options: { actor?: Actor; metadata?: Record<string, unknown> } = {},
  ): WorkflowRun {
    const timestamp = nowIso();
    const run: WorkflowRun = {
      id: newId("workflow"),
      status: "active",
      checkpoint: "drafting",
      objective,
      planPath: this.planPath,
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    const repositorySnapshot = this.repository.snapshot();
    this.ledger.saveWorkflowTransition({
      run,
      event: {
        kind: "workflow.started",
        actor: options.actor ?? "user",
        repositorySnapshot,
        payload: {
          ...(options.metadata ?? {}),
          workflowRunId: run.id,
          objective,
          path: this.planPath,
        },
      },
      clearStateKeys: ["reviewedPlanHash"],
    });
    return run;
  }

  currentWorkflowRun(): WorkflowRun | undefined {
    return this.ledger.getCurrentWorkflowRun();
  }

  begin(options: BeginPlanReviewOptions = {}): ManualEdit {
    ensurePlanDocument(this.planPath);
    const draft = readFileSync(this.planPath, "utf8");
    const formattedDraft = formatPlanTaskMetadataText(draft);
    if (formattedDraft !== draft) writeFileSync(this.planPath, formattedDraft, "utf8");
    const beforeRepositorySnapshot = this.repository.snapshot();
    const beforeSource = this.sourceState();
    const before = parsePlanText(readFileSync(this.planPath, "utf8"), this.planPath);
    const timestamp = nowIso();
    const existing = this.ledger.getCurrentWorkflowRun();
    const run: WorkflowRun = existing?.status === "active"
      ? { ...existing }
      : {
          id: newId("workflow"),
          status: "active",
          checkpoint: "review_pending",
          objective: this.ledger.getState<string>("planObjective") ?? "",
          planPath: this.planPath,
          startedAt: timestamp,
          updatedAt: timestamp,
        };
    const manualEdit: ManualEdit = {
      id: newId("manual-edit"),
      workflowRunId: run.id,
      purpose: "plan_review",
      status: "started",
      planPath: this.planPath,
      ...(options.editor === undefined ? {} : { editor: options.editor }),
      beforeHash: before.hash,
      beforeStructure: createPlanStructureSnapshot(before),
      beforeRepositorySnapshot,
      beforeSourceFingerprint: beforeSource.fingerprint,
      beforeSourcePaths: beforeSource.paths,
      changedPaths: [],
      driftStatus: "none",
      ambiguous: false,
      accepted: false,
      startedAt: timestamp,
    };
    const nextRun: WorkflowRun = {
      ...run,
      checkpoint: "reviewing",
      currentManualEditId: manualEdit.id,
      updatedAt: timestamp,
    };
    this.ledger.saveWorkflowTransition({
      run: nextRun,
      manualEdit,
      event: {
        kind: "manual_edit.started",
        actor: options.actor ?? "user",
        repositorySnapshot: beforeRepositorySnapshot,
        payload: {
          manualEditId: manualEdit.id,
          workflowRunId: run.id,
          purpose: manualEdit.purpose,
          path: this.planPath,
          beforeHash: before.hash,
          ...(manualEdit.editor === undefined ? {} : { editor: manualEdit.editor }),
        },
      },
      clearStateKeys: ["reviewedPlanHash"],
    });
    return manualEdit;
  }

  complete(id: string, options: CompletePlanReviewOptions = {}): ManualEdit {
    const current = this.requireStarted(id);
    if ((options.exitCode ?? 0) !== 0 || options.signal !== undefined || options.error !== undefined) {
      return this.cancel(id, {
        ...options,
        status: options.signal === undefined ? "failed" : "interrupted",
      });
    }
    if (!existsSync(this.planPath)) {
      this.cancel(id, { ...options, status: "failed", error: `The plan document was removed: ${this.planPath}` });
      throw new Error(`The plan document was removed: ${this.planPath}`);
    }

    const afterText = readFileSync(this.planPath, "utf8");
    const after = parsePlanText(afterText, this.planPath);
    const afterStructure = createPlanStructureSnapshot(after);
    const afterRepositorySnapshot = this.repository.snapshot();
    const afterSource = this.sourceState();
    const driftStatus = this.driftStatus(
      current.beforeRepositorySnapshot,
      afterRepositorySnapshot,
      current.beforeSourceFingerprint,
      afterSource.fingerprint,
    );
    const diagnostics = boundedDiagnostics(after.diagnostics);
    const blocking = diagnostics.some((diagnostic) => diagnostic.level === "error");
    const changed = current.beforeHash !== after.hash;
    const accepted = !blocking && driftStatus === "none";
    const timestamp = nowIso();
    const manualEdit: ManualEdit = {
      ...current,
      status: "completed",
      ...(options.editor === undefined ? {} : { editor: options.editor }),
      afterHash: after.hash,
      afterStructure,
      afterRepositorySnapshot,
      afterSourceFingerprint: afterSource.fingerprint,
      afterSourcePaths: afterSource.paths,
      changed,
      changedPaths: changed ? [this.planPath] : [],
      diagnostics,
      structuralDiff: diffPlanStructures(current.beforeStructure, afterStructure),
      driftStatus,
      ambiguous: driftStatus !== "none",
      accepted,
      ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
      finishedAt: timestamp,
    };
    const run = this.requireWorkflowRun(current.workflowRunId);
    const { reviewedPlanHash: _reviewedPlanHash, ...runWithoutReviewedHash } = run;
    const nextRun: WorkflowRun = {
      ...runWithoutReviewedHash,
      checkpoint: accepted ? "reviewed" : "review_pending",
      currentManualEditId: manualEdit.id,
      ...(accepted ? { reviewedPlanHash: after.hash } : {}),
      updatedAt: timestamp,
    };
    const stateUpdates = accepted ? { reviewedPlanHash: after.hash } : undefined;
    this.ledger.saveWorkflowTransition({
      run: nextRun,
      manualEdit,
      event: {
        kind: "manual_edit.completed",
        actor: options.actor ?? "user",
        repositorySnapshot: afterRepositorySnapshot,
        payload: {
          manualEditId: manualEdit.id,
          workflowRunId: manualEdit.workflowRunId,
          path: this.planPath,
          beforeHash: manualEdit.beforeHash,
          afterHash: after.hash,
          changed,
          changedPaths: manualEdit.changedPaths,
          editor: manualEdit.editor,
          diagnostics,
          structuralDiff: manualEdit.structuralDiff,
          driftStatus,
          ambiguous: manualEdit.ambiguous,
          accepted,
        },
      },
      ...(stateUpdates === undefined ? {} : { stateUpdates }),
      ...(accepted ? {} : { clearStateKeys: ["reviewedPlanHash"] }),
    });
    return manualEdit;
  }

  cancel(id: string, options: CancelPlanReviewOptions): ManualEdit {
    const current = this.requireStarted(id);
    const timestamp = nowIso();
    const afterRepositorySnapshot = this.repository.snapshot();
    const afterSource = this.sourceState();
    const after = existsSync(this.planPath)
      ? parsePlanText(readFileSync(this.planPath, "utf8"), this.planPath)
      : undefined;
    const afterEvidence = (() => {
      if (after === undefined) return {};
      const afterStructure = createPlanStructureSnapshot(after);
      const changed = current.beforeHash !== after.hash;
      return {
        afterHash: after.hash,
        afterStructure,
        changed,
        changedPaths: changed ? [this.planPath] : [],
        diagnostics: boundedDiagnostics(after.diagnostics),
        structuralDiff: diffPlanStructures(current.beforeStructure, afterStructure),
      };
    })();
    const manualEdit: ManualEdit = {
      ...current,
      status: options.status,
      ...(options.editor === undefined ? {} : { editor: options.editor }),
      ...afterEvidence,
      afterRepositorySnapshot,
      afterSourceFingerprint: afterSource.fingerprint,
      afterSourcePaths: afterSource.paths,
      driftStatus: this.driftStatus(
        current.beforeRepositorySnapshot,
        afterRepositorySnapshot,
        current.beforeSourceFingerprint,
        afterSource.fingerprint,
      ),
      ambiguous: true,
      accepted: false,
      ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.error === undefined ? {} : { error: options.error }),
      finishedAt: timestamp,
    };
    const run = this.requireWorkflowRun(current.workflowRunId);
    const { reviewedPlanHash: _reviewedPlanHash, ...runWithoutReviewedHash } = run;
    const nextRun: WorkflowRun = {
      ...runWithoutReviewedHash,
      checkpoint: "review_pending",
      currentManualEditId: manualEdit.id,
      updatedAt: timestamp,
    };
    this.ledger.saveWorkflowTransition({
      run: nextRun,
      manualEdit,
      event: {
        kind: `manual_edit.${options.status}`,
        actor: options.actor ?? "user",
        repositorySnapshot: afterRepositorySnapshot,
        payload: {
          manualEditId: manualEdit.id,
          workflowRunId: manualEdit.workflowRunId,
          path: this.planPath,
          status: options.status,
          editor: manualEdit.editor,
          exitCode: manualEdit.exitCode,
          signal: manualEdit.signal,
          error: manualEdit.error,
          beforeHash: manualEdit.beforeHash,
          afterHash: manualEdit.afterHash,
          changed: manualEdit.changed,
          changedPaths: manualEdit.changedPaths,
          diagnostics: manualEdit.diagnostics,
          structuralDiff: manualEdit.structuralDiff,
          driftStatus: manualEdit.driftStatus,
        },
      },
      clearStateKeys: ["reviewedPlanHash"],
    });
    return manualEdit;
  }

  private requireStarted(id: string): ManualEdit {
    const manualEdit = this.ledger.getManualEdit(id);
    if (manualEdit === undefined) throw new Error(`Unknown ManualEdit: ${id}`);
    if (manualEdit.status !== "started") {
      throw new Error(`ManualEdit ${id} is ${manualEdit.status}, not started.`);
    }
    return manualEdit;
  }

  private requireWorkflowRun(id: string): WorkflowRun {
    const run = this.ledger.getWorkflowRun(id);
    if (run === undefined) throw new Error(`Workflow run disappeared: ${id}`);
    return run;
  }

  private sourceState(): SourceState {
    const planRelative = normalizePath(repositoryRelativePath(this.repositoryRoot, this.planPath, "write"));
    const paths = [...new Set(this.repository.changedPaths().map(normalizePath))]
      .filter((path) => path !== planRelative)
      .sort();
    const entries = paths.map((path) => {
      const absolute = repositoryPathTarget(this.repositoryRoot, path, "read").absolute;
      let contentHash = "missing";
      try {
        contentHash = sha256(readFileSync(absolute));
      } catch {
        // Deleted paths and non-files are still represented by their repository diff.
      }
      return [path, contentHash, sha256(this.repository.diff(path))];
    });
    return { paths, fingerprint: sha256(JSON.stringify(entries)) };
  }

  private driftStatus(
    before: RepositorySnapshot,
    after: RepositorySnapshot,
    beforeSourceFingerprint: string,
    afterSourceFingerprint: string,
  ): ManualEdit["driftStatus"] {
    if (
      before.repositoryId !== after.repositoryId
      || before.workspaceId !== after.workspaceId
      || before.vcs !== after.vcs
    ) {
      return "workspace_changed";
    }
    const revisionChanged = before.vcs === "git"
      ? before.headCommit !== after.headCommit
      : before.vcs === "jj"
        ? before.changeId !== after.changeId
        : false;
    return revisionChanged || beforeSourceFingerprint !== afterSourceFingerprint
      ? "repository_changed"
      : "none";
  }
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function boundedDiagnostics(diagnostics: PlanDiagnostic[]): PlanDiagnostic[] {
  return diagnostics.slice(0, 100).map((diagnostic) => ({ ...diagnostic }));
}
