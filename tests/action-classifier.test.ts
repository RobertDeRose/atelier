import test from "node:test";
import assert from "node:assert/strict";
import { classifyShellCommand } from "../packages/core/src/policy/action-classifier.ts";

test("classifies common read-only commands", () => {
  assert.equal(classifyShellCommand("git status --short").action, "read.repository");
  assert.equal(classifyShellCommand("bd ready --json").action, "read.repository");
  assert.equal(classifyShellCommand("rg TODO src").mutating, false);
});

test("classifies task, repository, dependency, and file mutations", () => {
  assert.equal(classifyShellCommand("bd create Example --json").action, "task.create");
  assert.equal(classifyShellCommand("git push origin main").action, "repository.publish");
  assert.equal(classifyShellCommand("npm install zod").action, "dependency.modify");
  assert.equal(classifyShellCommand("aube add zod").action, "dependency.modify");
  assert.equal(classifyShellCommand("aubr test").action, "command.long_running");
  assert.equal(classifyShellCommand("printf test > output.txt").action, "write.file");
});

test("unknown and compound commands require explicit execution approval", () => {
  const unknown = classifyShellCommand("my-project-script --fix");
  const compound = classifyShellCommand("cat a && rm b");

  assert.equal(unknown.action, "command.execute");
  assert.equal(unknown.confidence, "low");
  assert.equal(compound.action, "command.execute");
  assert.equal(compound.mutating, true);
});
