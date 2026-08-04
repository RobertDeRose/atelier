import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripLaunchArguments } from "../apps/cli/src/arguments.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const installScript = join(repositoryRoot, "scripts", "install-atlr-wrapper.sh");
const miseConfig = readFileSync(join(repositoryRoot, "mise.toml"), "utf8");

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("launch initializes the selected workspace through a hidden, freshness-aware task", () => {
  assert.match(miseConfig, /\[tasks\.init\][\s\S]*?aube install --frozen-lockfile/);
  assert.match(miseConfig, /\[tasks\.workspace-init\][\s\S]*?hide\s*=\s*true/);
  assert.match(miseConfig, /\[tasks\.workspace-init\][\s\S]*?dir\s*=\s*"\{\{cwd\}\}"/);
  assert.match(miseConfig, /\[tasks\.workspace-init\][\s\S]*?sources\s*=\s*\[/);
  assert.match(miseConfig, /\[tasks\.workspace-init\][\s\S]*?outputs\s*=\s*\[/);
  assert.match(miseConfig, /\.atelier\/config\.json/);
  assert.match(miseConfig, /\[tasks\.launch\][\s\S]*?depends\s*=\s*\["workspace-init"\]/);
  for (const taskHeader of miseConfig.matchAll(/^\[tasks\.(.+)\]$/gm)) {
    const escapedHeader = taskHeader[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const taskBlock = miseConfig.match(new RegExp(`${escapedHeader}[\\s\\S]*?(?=\\n\\[tasks\\.|$)`))?.[0];
    assert.ok(taskBlock, `missing task block for ${taskHeader[1]}`);
    assert.ok(taskBlock.includes("\nquiet = true"), `${taskHeader[1]} should be quiet`);
  }
});

test("launch accepts an optional workspace path and defaults it to the caller directory", () => {
  assert.match(miseConfig, /\[tasks\.launch\][\s\S]*?usage\s*=\s*'''[\s\S]*?arg "\[workspace_path\]"/);
  assert.match(miseConfig, /\[tasks\.launch\][\s\S]*?default="\{\{cwd\}\}"/);
  assert.match(miseConfig, /usage_workspace_path/);
  assert.match(miseConfig, /MISE_ORIGINAL_CWD/);
  assert.match(miseConfig, /--root "\$workspace_path"/);
});

test("launch removes Atelier-only global options before forwarding arguments to Pi", () => {
  assert.deepEqual(
    stripLaunchArguments(["atlr", "launch", "--", "--root", "/tmp/workspace", "--workspace=/tmp/other", "--no-session"]),
    ["--no-session"],
  );
});

test("install_wrapper creates an executable atlr shim bound to the source checkout", () => {
  const installDirectory = temporaryDirectory("atlr-wrapper-install-");
  const result = spawnSync("bash", [installScript], {
    cwd: repositoryRoot,
    env: { ...process.env, ATLR_WRAPPER_INSTALL_DIR: installDirectory },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const wrapper = join(installDirectory, "atlr");
  const mode = statSync(wrapper).mode & 0o111;
  assert.notEqual(mode, 0);
  const content = readFileSync(wrapper, "utf8");
  assert.match(content, /ATELIER_REPOSITORY=/);
  assert.match(content, /--root "\$workspace_root"/);
  assert.match(content, /bin\/atlr\.mjs/);
});

test("the installed shim routes launch through the freshness-aware mise task", () => {
  const installDirectory = temporaryDirectory("atlr-wrapper-install-");
  const fakeBin = join(installDirectory, "bin");
  const workspace = join(installDirectory, "workspace");
  const capture = join(installDirectory, "mise-args");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(workspace);
  const install = spawnSync("bash", [installScript], {
    cwd: repositoryRoot,
    env: { ...process.env, ATLR_WRAPPER_INSTALL_DIR: installDirectory },
    encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const fakeMise = join(fakeBin, "mise");
  writeFileSync(fakeMise, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >"${capture}"\n`, "utf8");
  chmodSync(fakeMise, 0o755);
  const result = spawnSync(join(installDirectory, "atlr"), ["launch", "--no-session"], {
    cwd: workspace,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const args = readFileSync(capture, "utf8").trim().split("\n");
  assert.deepEqual(args.slice(0, 2), ["run", "launch"]);
  assert.equal(args[2], realpathSync(workspace));
  assert.deepEqual(args.slice(3), ["--", "--no-session"]);
});

test("the installed shim passes the caller directory as the default workspace", () => {
  const installDirectory = temporaryDirectory("atlr-wrapper-install-");
  const fakeBin = join(installDirectory, "bin");
  const workspace = join(installDirectory, "workspace");
  const capture = join(installDirectory, "mise-args");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(workspace);
  const install = spawnSync("bash", [installScript], {
    cwd: repositoryRoot,
    env: { ...process.env, ATLR_WRAPPER_INSTALL_DIR: installDirectory },
    encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const fakeMise = join(fakeBin, "mise");
  writeFileSync(fakeMise, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >"${capture}"\n`, "utf8");
  chmodSync(fakeMise, 0o755);
  const result = spawnSync(join(installDirectory, "atlr"), ["doctor"], {
    cwd: workspace,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const args = readFileSync(capture, "utf8").trim().split("\n");
  assert.deepEqual(args.slice(0, 3), ["exec", "--cd", repositoryRoot]);
  assert.equal(args.at(-1), "doctor");
  const rootIndex = args.indexOf("--root");
  assert.ok(rootIndex >= 0);
  assert.equal(args[rootIndex + 1], realpathSync(workspace));
});
