import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitDecisionAndPark, readResumptionIntent } from "../src/decision-emit.ts";
import { listPendingDecisions } from "../src/decision.ts";
import { resumptionIntentPath } from "../src/paths.ts";

function tmpVault(): string { return mkdtempSync(join(tmpdir(), "vos-emit-")); }

test("emitDecisionAndPark appends a Decision AND writes the resumption-intent file (keyed by decisionId)", () => {
  const v = tmpVault();
  const { decision } = emitDecisionAndPark(v, {
    execId: "ex-emit-1", question: "Push to prod?", options: ["yes", "no"],
    context: "deploy void-admin",
    resumeSkill: "do-the-deploy", resumeAgent: "default",
    resumePayload: "run: cd workspace/void-admin && ./deploy.sh", now: 5000,
  });
  // Decision is in the pending list.
  const pending = listPendingDecisions(v);
  expect(pending.find((d) => d.id === decision.id)).toBeTruthy();
  expect(decision.originExecId).toBe("ex-emit-1");
  // Resumption-intent file exists at the path keyed by decisionId (not execId).
  const intentPath = resumptionIntentPath(v, decision.id);
  expect(existsSync(intentPath)).toBe(true);
  const intent = readResumptionIntent(v, decision.id);
  expect(intent.decisionId).toBe(decision.id);
  expect(intent.resumeSkill).toBe("do-the-deploy");
  expect(intent.resumeAgent).toBe("default");
  expect(intent.resumePayload).toContain("deploy.sh");
});

test("two decisions from the same execId each get their own intent file (no clobber)", () => {
  const v = tmpVault();
  const { decision: d1 } = emitDecisionAndPark(v, {
    execId: "ex-multi", question: "Approve skill A?", options: ["approve", "reject"],
    context: "create skill-a", resumeSkill: "skill-manage-apply", resumeAgent: "default",
    resumePayload: JSON.stringify({ txnId: "txn-a", action: "create", name: "skill-a" }), now: 1000,
  });
  const { decision: d2 } = emitDecisionAndPark(v, {
    execId: "ex-multi", question: "Approve skill B?", options: ["approve", "reject"],
    context: "create skill-b", resumeSkill: "skill-manage-apply", resumeAgent: "default",
    resumePayload: JSON.stringify({ txnId: "txn-b", action: "create", name: "skill-b" }), now: 2000,
  });
  // Both decisions must be independently readable (not clobbered).
  const i1 = readResumptionIntent(v, d1.id);
  const i2 = readResumptionIntent(v, d2.id);
  expect(JSON.parse(i1.resumePayload).txnId).toBe("txn-a");
  expect(JSON.parse(i2.resumePayload).txnId).toBe("txn-b");
});

test("readResumptionIntent throws when intent file is missing", () => {
  const v = tmpVault();
  expect(() => readResumptionIntent(v, "nope")).toThrow();
});
