import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { redactText, redactValue } from "../packages/core/src/security/redaction.ts";
import { SqliteLedger } from "../packages/core/src/ledger/sqlite-ledger.ts";

test("redaction removes environment credentials and common inline secret forms", () => {
  const environment = { API_TOKEN: "abcdefgh-secret-value" };
  assert.equal(redactText("token=abc123456789 Bearer xyz.abc and abcdefgh-secret-value", environment).includes("abcdefgh-secret-value"), false);
  assert.equal(JSON.stringify(redactValue({ password: "visible", nested: "authorization: Basic abcdefghijk" })).includes("visible"), false);
});

test("ledger redacts events and exposes bounded lifecycle controls", () => {
  const root = mkdtempSync(join(tmpdir(), "atlr-redaction-"));
  const ledger = new SqliteLedger(join(root, "atelier.db"));
  ledger.append({ kind: "test.secret", actor: "system", payload: { password: "do-not-store", text: "Bearer abcdefghijk" } });
  const event = ledger.listEvents({ limit: 1 })[0]!;
  assert.equal(JSON.stringify(event).includes("do-not-store"), false);
  assert.equal(ledger.dataSummary().ledger_events, 1);
  const exported = ledger.exportData();
  assert.equal(JSON.stringify(exported).includes("do-not-store"), false);
  const deleted = ledger.deleteHistoricalData();
  assert.equal(deleted.ledger_events, 1);
  ledger.close();
});
