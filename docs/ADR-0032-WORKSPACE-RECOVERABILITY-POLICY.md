# ADR-0032: Session workspace recoverability policy

Status: Accepted

Atelier no longer maintains a project-trust database or a second trust command. The canonical startup directory is the immutable session workspace. Pi `/trust` remains independent and controls only Pi project-local resources.

Structured tool and user shell effects are evaluated by four components: effect analysis, workspace guarding, VCS path-state classification, and recovery checkpointing. Ordinary in-workspace reads, creates, and recoverable tracked mutations are allowed. Secret access, privilege escalation, workspace escape, and indeterminate effects ask once for the concrete operation. Dirty or untracked destructive changes are checkpointed before execution when exact recovery is practical.

Task execution contracts remain task authority, not filesystem trust. They constrain what an approved task should modify while the workspace policy decides whether the concrete effect is recoverable and contained.
