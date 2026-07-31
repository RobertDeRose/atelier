import assert from "node:assert/strict";
import test from "node:test";
import { isSecretEnvironmentName, minimalEnvironment } from "../packages/core/src/process/environment.ts";

test("minimal subprocess environments exclude host credentials and preserve runtime essentials", () => {
  const source: NodeJS.ProcessEnv = {
    PATH: "/bin",
    HOME: "/home/test",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    GITHUB_TOKEN: "secret-token",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    GIT_CONFIG_GLOBAL: "/tmp/isolated.gitconfig",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    SAFE_FLAG: "allowed",
  };
  const environment = minimalEnvironment({ source, allow: ["SAFE_FLAG", "GITHUB_TOKEN"] });
  assert.equal(environment.PATH, "/bin");
  assert.equal(environment.LC_ALL, "C");
  assert.equal(environment.SAFE_FLAG, "allowed");
  assert.equal(environment.GIT_CONFIG_GLOBAL, "/tmp/isolated.gitconfig");
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.SSH_AUTH_SOCK, undefined);
});

test("secret-shaped environment names cannot be explicitly allowlisted", () => {
  for (const name of ["API_KEY", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "PASSWORD", "SSH_AUTH_SOCK"]) {
    assert.equal(isSecretEnvironmentName(name), true, name);
  }
  assert.equal(isSecretEnvironmentName("RUST_LOG"), false);
});
