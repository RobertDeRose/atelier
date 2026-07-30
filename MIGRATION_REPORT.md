# Migration Report — Atelier 0.14.0-alpha.10

## Permission and trust migration

Atelier no longer uses a project-trust database, `/atelier-trust`, permission profiles, or remembered blanket approvals. Old Atelier trust records are ignored and are not reinterpreted as workspace roots.

The session workspace defaults to the canonical directory from which Atelier starts. `--workspace PATH` explicitly overrides it for the current process. Pi `/trust` remains independent and controls only project-local Pi resources.

Existing execution-linked task grants remain part of exact plan execution, but filesystem authorization is decided by workspace containment, secret sensitivity, privilege escalation, and recoverability.

## Plan migration

Existing plans with valid `execution` metadata continue to parse. Use `atlr plan scope` or `/plan-scope` to update execution metadata canonically and generate a readable Authorization section.

## Beads migration

Atelier opts into `BD_JSON_ENVELOPE=1` and accepts both legacy and v2 envelope responses. No Beads data migration is performed.

## Runtime and evidence

Subprocesses receive a minimal environment. Persisted evidence is redacted. New `atlr data` commands inspect, export, prune, or delete historical retained evidence.

## Service

`atlr serve` starts a serialized local Core service. `atlr service status|state|stop` queries it through the runtime socket. Existing Pi and CLI use remains compatible without running the service.
