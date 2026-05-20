// plugin/e2e/helpers/journey-report.ts
//
// VOS-163: per-stage report accumulator for the operator-journey spec.
// Each stage appends a StageResult; the spec's afterAll hook serialises
// the array to test-results/operator-journey-report.json and prints a
// human-readable table. On a first full run, the FAIL / drift rows ARE
// the surfaced-issues list the orchestrator turns into separate tasks.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LayoutVerdict = "ok" | "drift" | "first-run";

export interface StageResult {
  stage: string;
  screenshotPath: string;
  layoutVerdict: LayoutVerdict;
  pass: boolean;
  note?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// plugin/e2e/helpers -> plugin/test-results
const REPORT_PATH = resolve(
  HERE,
  "..",
  "..",
  "test-results",
  "operator-journey-report.json",
);
const SHOT_DIR = resolve(HERE, "..", "..", "test-results", "journey-shots");

const results: StageResult[] = [];

/** Append a stage outcome. Safe to call once per stage. */
export function recordStage(r: StageResult): void {
  results.push(r);
}

/**
 * Serialise the accumulated stage results to disk and print a table.
 * Returns the report path. Called from the spec's afterAll hook.
 */
export function writeJourneyReport(): string {
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), stages: results },
      null,
      2,
    ),
  );
  const rows = results.map(
    (r) =>
      `  ${r.pass ? "PASS" : "FAIL"}  ${r.stage.padEnd(20)} layout=${r.layoutVerdict.padEnd(10)} ${r.screenshotPath}${r.note ? `  — ${r.note}` : ""}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    ["", "── operator-journey report ──", ...rows, "", `report: ${REPORT_PATH}`, ""].join("\n"),
  );
  return REPORT_PATH;
}

/** Absolute path for a stage's explicit screenshot artifact. */
export function stageShotPath(stage: string): string {
  mkdirSync(SHOT_DIR, { recursive: true });
  return join(SHOT_DIR, `${stage}.png`);
}
