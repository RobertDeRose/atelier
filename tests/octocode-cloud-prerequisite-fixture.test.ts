import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const environment = JSON.parse(readFileSync("tests/fixtures/octocode-cloud-prerequisite/embedding_environment.json", "utf8")) as {
  codeModel: string;
  requiredKey: string;
  configured: boolean;
};
const models = readFileSync("tests/fixtures/octocode-cloud-prerequisite/config_show.txt", "utf8");

test("real Octocode fixture records a cloud default despite locally available embedding support", () => {
  assert.equal(environment.codeModel, "voyage:voyage-code-3");
  assert.equal(environment.requiredKey, "VOYAGE_API_KEY");
  assert.equal(environment.configured, false);
  assert.match(models, /Voyage API key: .*Not set/);
});
