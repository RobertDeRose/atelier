import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const smoke = join(process.cwd(), "scripts", "smoke.sh");

function empty(path: string): boolean {
  return readdirSync(path).length === 0;
}

test("smoke repositories are removed after success, failure, and cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-smoke-cleanup-"));
  try {
    const successTmp = join(root, "success");
    const failureTmp = join(root, "failure");
    const cancellationTmp = join(root, "cancellation");
    const successLog = join(root, "success-path");
    const failureLog = join(root, "failure-path");
    const cancellationLog = join(root, "cancellation-path");
    for (const path of [successTmp, failureTmp, cancellationTmp]) mkdirSync(path, { recursive: true });

    const success = spawnSync("bash", [smoke], {
      encoding: "utf8",
      shell: false,
      env: { ...process.env, TMPDIR: successTmp, ATLR_SMOKE_TMP_LOG: successLog },
    });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(empty(successTmp), true);
    assert.equal(existsSync(readFileSync(successLog, "utf8").trim()), false);

    const fakeBin = join(root, "bin");
    mkdirSync(fakeBin, { recursive: true });
    const fakeNode = join(fakeBin, "node");
    writeFileSync(fakeNode, "#!/usr/bin/env bash\nexit 17\n", "utf8");
    chmodSync(fakeNode, 0o755);
    const failure = spawnSync("bash", [smoke], {
      encoding: "utf8",
      shell: false,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        TMPDIR: failureTmp,
        ATLR_SMOKE_TMP_LOG: failureLog,
      },
    });
    assert.notEqual(failure.status, 0);
    assert.equal(empty(failureTmp), true);
    assert.equal(existsSync(readFileSync(failureLog, "utf8").trim()), false);

    const marker = join(root, "node-started");
    writeFileSync(fakeNode, `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\ntrap 'exit 130' TERM INT HUP\nwhile true; do sleep 1; done\n`, "utf8");
    chmodSync(fakeNode, 0o755);
    const child = spawn("bash", [smoke], {
      detached: true,
      stdio: "ignore",
      shell: false,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        TMPDIR: cancellationTmp,
        ATLR_SMOKE_TMP_LOG: cancellationLog,
      },
    });
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt += 1) await delay(20);
    assert.equal(existsSync(marker), true);
    assert.ok(child.pid);
    const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
    process.kill(-child.pid, "SIGTERM");
    const exitedInTime = await Promise.race([exited, delay(5_000).then(() => false)]);
    if (!exitedInTime) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      await exited;
    }
    assert.equal(exitedInTime, true, "cancelled smoke process must exit promptly");
    assert.equal(empty(cancellationTmp), true);
    assert.equal(existsSync(readFileSync(cancellationLog, "utf8").trim()), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
