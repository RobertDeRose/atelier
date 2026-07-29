const WORKFLOW_METADATA_ROOTS = [
  ".atelier",
  ".beads",
  ".dolt",
  ".codesearch",
  ".octocode",
] as const;

const DEPENDENCY_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.json",
  "deno.jsonc",
  "deno.lock",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "Pipfile",
  "Pipfile.lock",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
  "mix.exs",
  "mix.lock",
  "flake.nix",
  "flake.lock",
  "mise.toml",
  "mise.lock",
]);

/** Dependency manifests and locks require dependency.modify, never plain file.write. */
export function isDependencyPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const basename = normalized.split("/").at(-1) ?? normalized;
  return DEPENDENCY_BASENAMES.has(basename)
    || /^requirements(?:[._-][^/]*)?\.txt$/i.test(basename);
}

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
