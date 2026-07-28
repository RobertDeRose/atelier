const WORKFLOW_METADATA_ROOTS = [
  ".atelier",
  ".beads",
  ".dolt",
  ".codesearch",
  ".octocode",
] as const;

/**
 * Paths managed by Atelier, task providers, or code-index providers are not
 * application source. They must not invalidate a reviewed source baseline,
 * satisfy mutation evidence, or get swept into an approved task commit.
 */
export function isSourcePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return !WORKFLOW_METADATA_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export function sourcePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(isSourcePath))].sort();
}
