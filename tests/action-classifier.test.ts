import test from "node:test";
import assert from "node:assert/strict";
import { classifyShellCommand } from "../packages/core/src/policy/action-classifier.ts";

test("classifies common and compound read-only commands", () => {
  assert.equal(classifyShellCommand("git status --short").action, "read.repository");
  assert.equal(classifyShellCommand("bd ready --json").action, "read.repository");
  assert.equal(classifyShellCommand("rg TODO src").mutating, false);
  assert.equal(
    classifyShellCommand(
      "find examples -maxdepth 3 -type f -print -exec wc -l {} \\; 2>/dev/null; " +
        "rg -n 'approve|review|ready|validate' apps packages tests scripts docs | head -80",
    ).action,
    "read.repository",
  );
  assert.equal(
    classifyShellCommand(
      "git log -8 --oneline && printf '\\nExamples:\\n' && " +
        "git ls-files examples scripts README.md tests | grep -E '(^examples/|demo|smoke)'",
    ).action,
    "read.repository",
  );
});

test("classifies Git diff output options as file mutations", () => {
  for (const command of [
    "git diff --output=diff.txt",
    "git diff --output diff.txt",
    "git diff -odiff.txt",
    "git diff -o diff.txt",
  ]) {
    const classification = classifyShellCommand(command);
    assert.equal(classification.action, "write.file", command);
    assert.equal(classification.mutating, true, command);
  }
  assert.equal(classifyShellCommand("git diff --stat").action, "read.repository");
});

test("classifies task, repository, dependency, and file mutations", () => {
  assert.equal(classifyShellCommand("bd create Example --json").action, "task.create");
  assert.equal(classifyShellCommand("git push origin main").action, "repository.publish");
  assert.equal(classifyShellCommand("npm install zod").action, "dependency.modify");
  assert.equal(classifyShellCommand("aube add zod").action, "dependency.modify");
  assert.equal(classifyShellCommand("aubr test").action, "command.long_running");
  assert.equal(classifyShellCommand("printf test > output.txt").action, "write.file");
  assert.equal(classifyShellCommand("git commit -am 'finish task'").risk, "routine");
  assert.equal(classifyShellCommand("git reset --hard HEAD~1").risk, "destructive");
  assert.equal(classifyShellCommand("jj abandon @").risk, "destructive");
  assert.equal(classifyShellCommand("rm -rf build").risk, "destructive");
  assert.equal(classifyShellCommand("mise run check").risk, "routine");
  assert.equal(classifyShellCommand("node --test tests/unit.test.ts").risk, "routine");
  assert.equal(classifyShellCommand("curl https://example.com").risk, "external");
});

test("unknown and mutating compound commands still require approval", () => {
  const unknown = classifyShellCommand("my-project-script --fix");
  const compound = classifyShellCommand("cat a && rm b");
  const findExec = classifyShellCommand("find . -exec rm {} \\;");

  assert.equal(unknown.action, "command.execute");
  assert.equal(unknown.confidence, "low");
  assert.equal(unknown.risk, "unknown");
  assert.equal(compound.action, "write.file");
  assert.equal(compound.mutating, true);
  assert.equal(findExec.action, "write.file");
  assert.equal(classifyShellCommand("find build -type f -delete").action, "write.file");
  assert.equal(classifyShellCommand("find . -type f -fprint files.txt").action, "write.file");
  assert.equal(classifyShellCommand("printf test > output.txt").action, "write.file");
});
