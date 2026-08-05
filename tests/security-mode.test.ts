import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AtelierCore, loadConfig, runSandboxedShell } from "../packages/core/src/index.ts";
import { authorizeShellEffects } from "../apps/pi-extension/src/tool-authorization.ts";
import { createTemporaryRepository } from "./fixtures.ts";

test("core-only mode disables workspace enforcement and forces sandbox none", async () => {
  const root = createTemporaryRepository("atlr-core-only-policy-");
  const configPath = join(root, ".atelier", "config.json");
  try {
    const existing = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, `${JSON.stringify({ ...existing, securityMode: "core-only", sandboxBackend: "auto" })}\n`, "utf8");
    const config = loadConfig(root);
    assert.equal(config.securityMode, "core-only");
    assert.equal(config.sandboxBackend, "none");

    const core = AtelierCore.open(root, { taskProvider: "none" });
    try {
      const decision = core.evaluateWorkspaceEffects([
        { kind: "read", path: "/outside/agent-skill.md" },
        { kind: "overwrite", path: join(root, "README.md"), destructive: true },
      ]);
      assert.equal(decision.result, "allow");
      assert.ok(decision.effects.every((effect) => effect.decision === "allow"));
    } finally {
      await core.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enforced mode retains workspace policy decisions", async () => {
  const root = createTemporaryRepository("atlr-enforced-policy-");
  const configPath = join(root, ".atelier", "config.json");
  try {
    const existing = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, `${JSON.stringify({ ...existing, securityMode: "enforced", sandboxBackend: "none" })}\n`, "utf8");
    const core = AtelierCore.open(root, { taskProvider: "none" });
    try {
      const decision = core.evaluateWorkspaceEffects([{ kind: "read", path: "/outside/agent-skill.md" }]);
      assert.equal(decision.result, "ask");
    } finally {
      await core.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("core-only Pi shell authorization skips approval and runs unsandboxed", async () => {
  const root = createTemporaryRepository("atlr-core-only-shell-");
  const configPath = join(root, ".atelier", "config.json");
  try {
    const existing = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, `${JSON.stringify({ ...existing, securityMode: "core-only", sandboxBackend: "auto" })}\n`, "utf8");
    const core = AtelierCore.open(root, { taskProvider: "none" });
    const confirmations = { count: 0 };
    const context = {
      hasUI: true,
      mode: "tui",
      ui: {
        setWorkingMessage: (): void => {},
        confirm: async (): Promise<boolean> => { confirmations.count += 1; return true; },
      },
    } as any;
    try {
      const authorization = await authorizeShellEffects([
        { kind: "overwrite", path: join(root, "README.md"), destructive: true },
      ], context, core);
      assert.equal(authorization.response, undefined);
      assert.equal(authorization.allowUnsandboxed, true);
      assert.equal(confirmations.count, 0);
      const result = await runSandboxedShell({
        workspace: root,
        cwd: root,
        command: "printf core-only",
        backend: core.config.sandboxBackend,
        allowUnsandboxed: authorization.allowUnsandboxed,
      });
      assert.equal(result.stdout, "core-only");
    } finally {
      await core.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new project initialization selects core-only mode explicitly", async () => {
  const root = createTemporaryRepository("atlr-core-only-init-");
  rmSync(join(root, ".atelier", "config.json"), { force: true });
  const core = AtelierCore.open(root, { taskProvider: "none" });
  try {
    core.initialize({ createPlan: false });
    const initialized = JSON.parse(readFileSync(join(root, ".atelier", "config.json"), "utf8")) as Record<string, unknown>;
    assert.equal(initialized.securityMode, "core-only");
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
