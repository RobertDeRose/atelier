import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PlanTask } from "../domain/types.ts";
import { isDependencyPath, isSourcePath } from "../repository/source-path.ts";

export interface ValidationConstraintDescriptor {
  name: string;
  category: "focused" | "full";
  required?: boolean;
}

export interface TaskExecutionScopeOptions {
  requireValidation?: boolean;
  repositoryRoots?: Readonly<Record<string, string>>;
  primaryRepositoryId?: string;
}

export interface TaskExecutionScope {
  planTaskId: string;
  writePaths: string[];
  fileWritePaths: string[];
  dependencyPaths: string[];
  allowDependencyChanges: boolean;
  focusedValidations: string[];
  fullValidations: string[];
  allowFullSuite: boolean;
  allowLocalChange: boolean;
}

function resolveApprovedPath(repositoryRoot: string, candidate: string, options: TaskExecutionScopeOptions): string {
  const separator = candidate.indexOf("::");
  const repositoryId = separator === -1 ? options.primaryRepositoryId : candidate.slice(0, separator);
  const relativeCandidate = separator === -1 ? candidate : candidate.slice(separator + 2);
  const selectedRoot = repositoryId === undefined ? repositoryRoot : options.repositoryRoots?.[repositoryId];
  if (selectedRoot === undefined) throw new Error(`Execution path ${candidate} names unknown workspace repository ${repositoryId}.`);
  const absolute = resolve(selectedRoot, relativeCandidate);
  const rel = relative(selectedRoot, absolute);
  if (isAbsolute(relativeCandidate) || rel === ".." || rel.startsWith(`..${sep}`) || !isSourcePath(rel)) {
    throw new Error(`Execution path ${candidate} is not a repository-relative application-source path.`);
  }
  return absolute;
}

export function deriveTaskExecutionScope(
  task: PlanTask,
  repositoryRoot: string,
  descriptors: ValidationConstraintDescriptor[],
  options: TaskExecutionScopeOptions = {},
): TaskExecutionScope {
  if (task.execution === undefined) {
    throw new Error(`Task ${task.id} has no exact execution contract in its atlr:task metadata.`);
  }
  const available = new Map(descriptors.map((item) => [item.name, item.category]));
  const focused = new Set<string>();
  const full = new Set<string>();
  for (const name of task.execution.validations) {
    const category = available.get(name);
    if (category === undefined) throw new Error(`Task ${task.id} names unknown validation ${name}.`);
    if (category === "focused") focused.add(name);
    else full.add(name);
  }
  if (full.size > 0 && !task.execution.allowFullSuite) {
    throw new Error(`Task ${task.id} names full-suite validation without allowFullSuite: true.`);
  }
  const configuredRequired = descriptors.filter((descriptor) => descriptor.required === true);
  if (options.requireValidation === true && configuredRequired.length > 0
    && !task.execution.validations.some((name) => configuredRequired.some((descriptor) => descriptor.name === name))) {
    throw new Error(
      `Task ${task.id} must name at least one configured required validation in its execution contract.`,
    );
  }
  const writePaths = [...new Set(task.execution.writePaths.map((path) => resolveApprovedPath(repositoryRoot, path, options)))].sort();
  const dependencyPaths = writePaths.filter((path) => isDependencyPath(relative(repositoryRoot, path)));
  if (dependencyPaths.length > 0 && !task.execution.allowDependencyChanges) {
    throw new Error(`Task ${task.id} includes dependency manifests but allowDependencyChanges is false.`);
  }
  return {
    planTaskId: task.id,
    writePaths,
    fileWritePaths: writePaths.filter((path) => !dependencyPaths.includes(path)),
    dependencyPaths,
    allowDependencyChanges: task.execution.allowDependencyChanges,
    focusedValidations: [...focused].sort(),
    fullValidations: [...full].sort(),
    allowFullSuite: task.execution.allowFullSuite,
    allowLocalChange: task.execution.allowLocalChange,
  };
}
