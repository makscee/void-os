import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitDecisionAndPark, readResumptionIntent } from "../src/decision-emit.ts";
import { listPendingDecisions } from "../src/decision.ts";
import { resumptionIntentPath } from "../src/paths.ts";

function tmpVault(): string { return mkdtempSync(join(tmpdir(), "vos-emit-")); }

test("emitDecisionAndPark appends a Decision AND writes the resumption-intent file", () => {
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
  // Resumption-intent file exists at the deterministic path keyed by the emitting execId.
  const intentPath = resumptionIntentPath(v, "ex-emit-1");
  expect(existsSync(intentPath)).toBe(true);
  const intent = readResumptionIntent(v, "ex-emit-1");
  expect(intent.decisionId).toBe(decision.id);
  expect(intent.resumeSkill).toBe("do-the-deploy");
  expect(intent.resumeAgent).toBe("default");
  expect(intent.resumePayload).toContain("deploy.sh");
});

test("readResumptionIntent throws when intent file is missing", () => {
  const v = tmpVault();
  expect(() => readResumptionIntent(v, "nope")).toThrow();
});
