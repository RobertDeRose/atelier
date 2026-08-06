# Quickstart

Atelier is currently an alpha and is installed directly from its repository
clone.

## Install Atelier

Install `mise` if it is not already available, then clone and build Atelier:

```sh
git clone https://github.com/RobertDeRose/atelier.git
cd atelier
mise install --locked
mise run init
```

Install Pi using its normal installation method. Atelier adds its Pi extension
when you launch it; the extension and the `atlr` command use the build from
this checkout.

## Install the `atlr` command

Install a small system-wide wrapper while you are in the Atelier checkout:

```sh
mise run install_wrapper
```

This places `atlr` in `/usr/local/bin`. If that directory requires elevated
permissions, the task fails without prompting and reports the required fix.
Run the task again after granting the permission.

The wrapper uses the pinned Atelier runtime from this checkout and treats your
current directory as the workspace. It lets you run Atelier from any project,
not only from the Atelier source directory.

## Start a project

Change to the project you want the agent to work on and launch Atelier:

```sh
cd /path/to/your/project
atlr launch
```

The first launch creates the small `.atelier/` project configuration and
prepares the runtime state automatically. Later launches reuse it and only
refresh setup when the project files are missing or stale.

If you want to inspect the environment without changing project files, run
`atlr doctor`. It prints a human-readable summary; add `--json` when a script
needs machine-readable output.

Atelier opens Pi with its extension and uses the directory you are in as the
workspace. If you are still in the Atelier checkout, you can launch another
project directly with the mise task instead:

```sh
mise run launch /path/to/your/project
```

Add Pi arguments after the workspace path when needed:

```sh
mise run launch /path/to/your/project -- --no-session
```

## Make your first change

You can describe the work in ordinary language; Atelier creates the structured
workflow around it.

1. In Pi, enter `/plan` and describe the change you want. Pi drafts a plan for
   you; you do not need to write the plan format yourself.
2. When the draft is ready, enter `/review`. Atelier opens the plan so you can
   read, edit, and save it.
3. Enter `/approve`. Atelier shows the exact tasks, files, and checks it is
   about to authorize. Approve it only when the summary matches your intent.
4. After approval, send an explicit implementation request. The first
   approved task is already active and the agent can work within the reviewed
   boundaries. Use `/execute` only to activate a later approved-plan task.
5. Enter `/validate focused` to run the checks selected for the changed files.
   Use `/status` or `/evidence` if you want to see the recorded result.
6. Enter `/review-diff` to inspect the final change. If it is correct, use
   `/commit MESSAGE` and then `/close` to finish the task.

To stop only the current agent turn, use `/atelier-stop`. To pause the active
workflow, use `/atelier-pause`; to cancel it without reverting source changes,
use `/cancel`.

For recovery, multi-repository work, and the complete command reference, see
the [User Guide](../user-guide/index.md).
