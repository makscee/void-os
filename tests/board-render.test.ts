// board-render.test.ts — VOS-228 P4: server-side card rendering (the live-data seam).
// The kanban panel ships with example cards; the daemon must replace them with REAL task
// cards parsed from the panel's data-vos-source glob, grouped into columns by task `state`.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBoardData, parseTaskCard } from "../src/pages.ts";

let vault: string;
beforeEach(() => { vault = mkdtempSync(join(tmpdir(), "vos-board-")); });
afterEach(() => { rmSync(vault, { recursive: true, force: true }); });

function task(name: string, fm: Record<string, string>, body = "") {
  const dir = join(vault, "work", "tasks", "active");
  mkdirSync(dir, { recursive: true });
  const front = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  writeFileSync(join(dir, name), `---\n${front}\n---\n${body}`);
}

const KANBAN = `<div data-vos-source="work/tasks/active/*.md">
  <div class="board">
    <div class="col" data-col="todo"><h2>Todo</h2><div class="cards" data-cards>
      <div class="card" data-id="example-1">Example task A</div>
    </div></div>
    <div class="col" data-col="doing"><h2>Doing</h2><div class="cards" data-cards></div></div>
    <div class="col" data-col="done"><h2>Done</h2><div class="cards" data-cards></div></div>
  </div>
</div>`;

test("parseTaskCard extracts id/title/state from frontmatter", () => {
  const card = parseTaskCard(`---\nid: ADM-37\ntitle: Cockpit polish\nstate: doing\n---\nbody`);
  expect(card.id).toBe("ADM-37");
  expect(card.title).toBe("Cockpit polish");
  expect(card.state).toBe("doing");
});

test("parseTaskCard handles quoted/bracket values + missing fields", () => {
  const card = parseTaskCard(`---\nid: "X-1"\ntitle: 'Has: a colon'\nprojects: [ADM, VAU]\n---`);
  expect(card.id).toBe("X-1");
  expect(card.title).toBe("Has: a colon");
  expect(card.state).toBe(""); // missing → empty
});

test("renderBoardData replaces example cards with real task cards grouped by state", () => {
  task("ADM-1-foo.md", { id: "ADM-1", title: "Foo task", state: "todo" });
  task("ADM-2-bar.md", { id: "ADM-2", title: "Bar task", state: "doing" });
  task("ADM-3-baz.md", { id: "ADM-3", title: "Baz task", state: "done" });
  const out = renderBoardData(vault, KANBAN);

  // example cards gone
  expect(out).not.toContain("Example task A");
  expect(out).not.toContain('data-id="example-1"');

  // real titles present as cards
  expect(out).toContain("Foo task");
  expect(out).toContain("Bar task");
  expect(out).toContain("Baz task");

  // grouped by state into the right column: the todo column's cards contains Foo, not Bar
  const todoCol = out.slice(out.indexOf('data-col="todo"'), out.indexOf('data-col="doing"'));
  expect(todoCol).toContain("Foo task");
  expect(todoCol).not.toContain("Bar task");
  const doneCol = out.slice(out.indexOf('data-col="done"'));
  expect(doneCol).toContain("Baz task");

  // card carries the task id for the (v1.5) move wiring
  expect(out).toContain('data-id="ADM-1"');
});

test("renderBoardData puts unknown-state tasks in the FIRST column (fallback)", () => {
  task("ADM-9-x.md", { id: "ADM-9", title: "Active task", state: "active" }); // no matching col
  const out = renderBoardData(vault, KANBAN);
  const todoCol = out.slice(out.indexOf('data-col="todo"'), out.indexOf('data-col="doing"'));
  expect(todoCol).toContain("Active task");
});

test("renderBoardData is a no-op for panels without a data-vos-source or data-cards", () => {
  const plain = `<div><p>no board here</p></div>`;
  expect(renderBoardData(vault, plain)).toBe(plain);
});

test("renderBoardData escapes task titles (no HTML injection from a task file)", () => {
  task("ADM-x.md", { id: "ADM-X", title: "<script>alert(1)</script>", state: "todo" });
  const out = renderBoardData(vault, KANBAN);
  expect(out).not.toContain("<script>alert(1)</script>");
  expect(out).toContain("&lt;script&gt;");
});

test("renderBoardData renders empty columns cleanly when no tasks match the glob", () => {
  // no task files written
  const out = renderBoardData(vault, KANBAN);
  expect(out).not.toContain("Example task A"); // examples still stripped
  expect(out).toContain('data-col="todo"');     // structure intact
});
