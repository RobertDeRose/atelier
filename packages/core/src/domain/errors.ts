export class AdeError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AdeError";
    this.code = code;
    this.details = details;
  }
}

export class ConfigurationError extends AdeError {
  constructor(message: string, details?: unknown) {
    super("configuration_error", message, details);
    this.name = "ConfigurationError";
  }
}

export class ProviderError extends AdeError {
  constructor(message: string, details?: unknown) {
    super("provider_error", message, details);
    this.name = "ProviderError";
  }
}

export class RepositoryObservationError extends AdeError {
  constructor(message: string, details?: unknown) {
    super("repository_observation_error", message, details);
    this.name = "RepositoryObservationError";
  }
}

export class PlanValidationError extends AdeError {
  constructor(message: string, details?: unknown) {
    super("plan_validation_error", message, details);
    this.name = "PlanValidationError";
  }
}
