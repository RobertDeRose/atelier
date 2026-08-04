# Atelier

Atelier helps coding agents work with you without losing the thread.

It gives an agent a durable memory of the work around a repository: what you
planned, which tasks are in progress, what changed, what was checked, and what
still needs your attention. You can restart a session, switch between tools, or
return after a conversation has been compacted without starting from zero.

Atelier is for developers who want the speed of agentic coding while keeping a
clear say in what happens to their workspace.

## Why Atelier

A coding agent can write useful code quickly, but a chat transcript is a poor
project history. It does not reliably preserve the reason for a change, the
files an agent was meant to touch, the checks that ran, or the work still left
to do. Atelier turns that surrounding context into durable, reviewable state.

It also gives the agent immediate coding insight without making it grep every
file or read an entire repository into context. The result is less repeated
setup, better continuity between sessions, and more useful context at the
moment a decision is made.

## What Atelier gives you

- **A stateful work history.** Plans, task progress, approvals, changes,
  validation, and recovery information survive restarts and context compaction.
- **A place to manage work.** Turn an idea into tasks, see what is ready, and
  keep the agent focused on one reviewed piece of work at a time.
- **Fast coding insight.** Ask focused questions about a codebase and receive
  bounded, relevant context instead of searching manually or loading
  everything.
- **Review before action.** See what the agent intends to do and approve the
  exact work before it starts.
- **Recoverable changes.** Keep a reliable trail of what was attempted and
  what changed, including when a process stops or a check becomes stale.
- **One workflow across sessions.** Use the `atlr` command or Pi and return to
  the same project state later.

## How Atelier fits your existing setup

You do not need to learn a new set of repository or coding tools to use
Atelier. If you already use Git or Jujutsu for repository history, Beads for
task tracking, or Codesearch or Octocode for code insight, Atelier works with
those tools locally rather than asking you to replace them. It uses their
existing information behind the scenes to give the agent durable history,
task context, and focused coding insight.

If you do not use one of those tools, that does not change the central Atelier
workflow. Your files stay on your machine, and you remain free to use the
editor, validation commands, and repository tools you prefer.

## What Atelier is not

- It is not a new editor or IDE. Use the editor you already like.
- It does not ask you to replace your repository or task tools. It works
  alongside them when they are available.
- It is not a cloud service. Your repository and project history remain local.
- It does not give an agent permission to change anything without boundaries.
  You decide what to review, approve, run, stop, validate, and close.
- It is not a hands-off operator. Atelier keeps the important decisions visible
  so you can stay in control while the agent does the work.
