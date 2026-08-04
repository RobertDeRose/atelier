const BASE_ENVIRONMENT_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "LANG", "TERM", "COLORTERM", "NO_COLOR", "CI", "TZ",
  "SystemRoot", "COMSPEC", "PATHEXT", "WINDIR",
  // These variables constrain Git configuration and interactivity without
  // granting access to credentials or agents. Preserving them keeps tests and
  // controlled launches isolated from workstation-global Git behavior.
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_ATTR_NOSYSTEM",
  "GIT_TERMINAL_PROMPT", "GCM_INTERACTIVE", "GIT_PAGER",
]);

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH|COOKIE|SESSION|SSH_AUTH_SOCK|AWS_|AZURE_|GCP_|GOOGLE_APPLICATION_CREDENTIALS|GITHUB_|GITLAB_|NPM_TOKEN|PYPI_TOKEN)/i;

const OCTOCODE_CREDENTIAL_NAMES = [
  "VOYAGE_API_KEY",
  "JINA_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "OCTOHUB_API_KEY",
  "TOGETHER_API_KEY",
] as const;

export interface MinimalEnvironmentOptions {
  source?: NodeJS.ProcessEnv | undefined;
  allow?: readonly string[] | undefined;
  overrides?: NodeJS.ProcessEnv | undefined;
}

export function isSecretEnvironmentName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Return only credentials explicitly supported by Octocode's embedding providers. */
export function octocodeCredentialEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(OCTOCODE_CREDENTIAL_NAMES.flatMap((name) => {
    const value = source[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

export function minimalEnvironment(options: MinimalEnvironmentOptions = {}): NodeJS.ProcessEnv {
  const source = options.source ?? process.env;
  const allowed = new Set(BASE_ENVIRONMENT_NAMES);
  for (const name of Object.keys(source)) if (name.startsWith("LC_")) allowed.add(name);
  for (const name of options.allow ?? []) {
    if (name && !isSecretEnvironmentName(name)) allowed.add(name);
  }

  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(options.overrides ?? {})) {
    if (value !== undefined) environment[name] = value;
  }
  environment.ATELIER_WORKSPACE_ROOT ??= source.ATELIER_WORKSPACE_ROOT;
  return environment;
}

export function explicitEnvironment(names: readonly string[], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (!name || isSecretEnvironmentName(name)) continue;
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
