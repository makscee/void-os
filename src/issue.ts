// src/issue.ts — parse a GitHub Issue body into Boxes (stories). Schema: docs/ralph/issue-schema.md
export type Gate = { kind: "auto"; check: string } | { kind: "human" };
export interface Box {
  title: string;
  checked: boolean;
  gate: Gate;
  prio: number;
  raw: string; // the full "- [ ] ..." line, for the targeted body re-write
}

const BOX_RE = /^- \[( |x)\] (.+)$/;

function parseAnnotations(line: string): { title: string; gate: Gate; prio: number } {
  const braces = [...line.matchAll(/\{([^}]*)\}/g)].map((m) => m[1].trim());
  let gate: Gate | undefined;
  let prio = 999;
  for (const b of braces) {
    if (b.startsWith("auto:")) gate = { kind: "auto", check: b.slice(5).trim() };
    else if (b === "human") gate = { kind: "human" };
    else if (/^p\d+$/.test(b)) prio = parseInt(b.slice(1), 10);
  }
  if (!gate) throw new Error(`box missing gate annotation: ${line}`);
  const title = line.replace(/\s*\{[^}]*\}/g, "").trim();
  return { title, gate, prio };
}

export function parseBoxes(body: string): Box[] {
  const boxes: Box[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(BOX_RE);
    if (!m) continue;
    const checked = m[1] === "x";
    const { title, gate, prio } = parseAnnotations(m[2]);
    boxes.push({ title, checked, gate, prio, raw: line });
  }
  return boxes;
}

export function allChecked(boxes: Box[]): boolean {
  return boxes.length > 0 && boxes.every((b) => b.checked);
}

/** Highest-priority OPEN box (lowest prio number), or undefined if none open. */
export function nextOpenBox(boxes: Box[]): Box | undefined {
  return boxes.filter((b) => !b.checked).sort((a, b) => a.prio - b.prio)[0];
}

/**
 * Lost-update-safe checkbox flip (runner-owned). Given a freshly-fetched body and
 * the target box, return a new body with ONLY that box's `- [ ]` line changed to
 * `- [x]`, matched by the box's exact `raw` line. Every other byte is preserved
 * (so a concurrent operator reshape of a human box is not clobbered). Idempotent.
 * The CALLER (drain runner) MUST pass a body it re-fetched immediately before.
 */
export function checkBox(body: string, box: Box): string {
  if (box.checked) return body;
  const checkedLine = box.raw.replace(/^- \[ \]/, "- [x]");
  const idx = body.indexOf(box.raw);
  if (idx === -1) return body; // reshaped away — no-op
  return body.slice(0, idx) + checkedLine + body.slice(idx + box.raw.length);
}

export function drainProgress(body: string): { checked: number; total: number } {
  const boxes = parseBoxes(body);
  return { checked: boxes.filter((b) => b.checked).length, total: boxes.length };
}
