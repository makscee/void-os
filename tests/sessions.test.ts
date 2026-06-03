import { expect, test, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { listSessions, isIdle, IDLE_MS } from "../src/sessions.ts";
import { bodyPath, sessionDir, stopPath, reapedPath } from "../src/paths.ts";
import { openRegistry, createExecution, setExecutionEnded, setExecutionFail } from "../src/registry.ts";

const vault = "/tmp/voidos-sessions-test";
beforeAll(() => {
  rmSync(vault, { recursive: true, force: true });
  for (const [u, t] of [["old", 1000], ["new", 2000]] as const) {
    mkdirSync(sessionDir(vault, u), { recursive: true });
    writeFileSync(bodyPath(vault, u), `<title>${u} session</title>`);
    utimesSync(bodyPath(vault, u), t, t);
  }
  // a session whose process died: error.txt present
  mkdirSync(sessionDir(vault, "broken"), { recursive: true });
  writeFileSync(bodyPath(vault, "broken"), "<title>broken</title>");
  utimesSync(bodyPath(vault, "broken"), 1500, 1500);
  writeFileSync(`${sessionDir(vault, "broken")}/error.txt`, "exit 1\nboom");
  // a session with a form (awaiting input)
  mkdirSync(sessionDir(vault, "awaiting"), { recursive: true });
  writeFileSync(bodyPath(vault, "awaiting"), "<title>form</title><form action='/send'><input name='x'></form>");
  utimesSync(bodyPath(vault, "awaiting"), 2500, 2500);
  // a session with session-meta.json and a generic title (title fallback test)
  mkdirSync(sessionDir(vault, "metasession"), { recursive: true });
  writeFileSync(bodyPath(vault, "metasession"), "<title>session starting…</title>");
  utimesSync(bodyPath(vault, "metasession"), 3000, 3000);
  writeFileSync(
    join(sessionDir(vault, "metasession"), "session-meta.json"),
    JSON.stringify({ skill: "deep-research", launchedAt: 3000, text: "" }),
  );
});

test("sorts newest body.html first, extracts title, flags errors", () => {
  const s = listSessions(vault);
  // metasession (3000) > awaiting (2500) > new (2000) > broken (1500) > old (1000)
  expect(s[0].uuid).toBe("metasession");
  expect(s[1].uuid).toBe("awaiting");
  expect(s.find((x) => x.uuid === "new")!.title).toBe("new session");
  expect(s.find((x) => x.uuid === "broken")!.error).toBe(true);
  expect(s.find((x) => x.uuid === "new")!.error).toBe(false);
});

test("status: error when error.txt present", () => {
  const s = listSessions(vault);
  expect(s.find((x) => x.uuid === "broken")!.status).toBe("error");
});

test("status: awaiting when body.html contains <form", () => {
  const s = listSessions(vault);
  expect(s.find((x) => x.uuid === "awaiting")!.status).toBe("awaiting");
});

test("status: complete for plain sessions without form or error", () => {
  const s = listSessions(vault);
  expect(s.find((x) => x.uuid === "new")!.status).toBe("complete");
});

test("title fallback uses skill name when title is generic", () => {
  const s = listSessions(vault);
  const meta = s.find((x) => x.uuid === "metasession")!;
  expect(meta.skill).toBe("deep-research");
  // title must not be "session starting…" — it should fall back to skill name
  expect(meta.title).not.toBe("session starting…");
  expect(meta.title).toContain("deep-research");
});

test("status: stopped when stopped.txt present (beats error)", () => {
  const uuid = "stopped-uuid-1";
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  writeFileSync(bodyPath(vault, uuid), "<title>stopped session</title>");
  writeFileSync(stopPath(vault, uuid), "stopped");
  const s = listSessions(vault).find((x) => x.uuid === uuid)!;
  expect(s.status).toBe("stopped");
});

test("sessions without body.html are excluded", () => {
  // create a dir with no body.html
  mkdirSync(sessionDir(vault, "nobodyhtml"), { recursive: true });
  const s = listSessions(vault);
  expect(s.map((x) => x.uuid)).not.toContain("nobodyhtml");
});

test("empty sessions root returns empty array", () => {
  const emptyVault = "/tmp/voidos-sessions-empty";
  rmSync(emptyVault, { recursive: true, force: true });
  mkdirSync(`${emptyVault}/sessions`, { recursive: true });
  expect(listSessions(emptyVault)).toEqual([]);
});

// ── VOS-208: Task 4 — VOS-206 non-regression + reaped→resume guard ───────────

test("VOS-206 non-regression: live form stays awaiting; resumed reaped session is not stuck reaped", () => {
  const v = "/tmp/voidos-status-resume";
  rmSync(v, { recursive: true, force: true });
  rmSync(`${v}.db`, { force: true });
  const db = openRegistry(`${v}.db`);
  // (a) live interactive awaiting — VOS-206 form round-trip stays one session
  mkdirSync(sessionDir(v, "live"), { recursive: true });
  writeFileSync(bodyPath(v, "live"), "<form action='/send'><input name='x'></form>");
  createExecution(db, { id: "live", agent: null, skill: null, inputRef: null,
    tmuxSession: "vos-run-live", now: 1, triggerId: null, stepCeiling: null });
  expect(listSessions(v, db).find((s) => s.uuid === "live")!.status).toBe("awaiting");
  // (b) resumed-after-reap: reaped.txt present but a live exec row exists again — must NOT be stuck reaped
  mkdirSync(sessionDir(v, "resumed"), { recursive: true });
  writeFileSync(bodyPath(v, "resumed"), "<title>resumed</title>");
  writeFileSync(reapedPath(v, "resumed"), "old reap\n");
  createExecution(db, { id: "resumed", agent: null, skill: null, inputRef: null,
    tmuxSession: "vos-run-resumed", now: 5, triggerId: null, stepCeiling: null });
  expect(listSessions(v, db).find((s) => s.uuid === "resumed")!.status).toBe("working");
});

// ── VOS-208: 6-state exec-aware deriveStatus regression matrix ───────────────

test("deriveStatus folds exec terminal/liveness state into 6 states", () => {
  const v = "/tmp/voidos-status-matrix";
  rmSync(v, { recursive: true, force: true });
  rmSync(`${v}.db`, { force: true });
  const db = openRegistry(`${v}.db`);

  const mk = (u: string, body: string) => {
    mkdirSync(sessionDir(v, u), { recursive: true });
    writeFileSync(bodyPath(v, u), body);
  };
  const exec = (id: string) =>
    createExecution(db, { id, agent: null, skill: null, inputRef: null,
      tmuxSession: `vos-run-${id}`, now: 1000, triggerId: null, stepCeiling: null });

  // 5 (working): exec live, no form
  mk("working", "<title>w</title>");
  exec("working");
  // 6 (complete): exec ended cleanly, no form
  mk("done", "<title>d</title>");
  exec("done");
  setExecutionEnded(db, "done", 2000);
  // 2 (error via reason): exec failed with reason, body advanced (no error.txt)
  mk("failed", "<title>f</title>");
  exec("failed");
  setExecutionFail(db, "failed", "runaway-ceiling", 2000);
  // 2 (error via error.txt): file marker
  mk("crashed", "<title>c</title>");
  exec("crashed");
  setExecutionEnded(db, "crashed", 2000);
  writeFileSync(`${sessionDir(v, "crashed")}/error.txt`, "exit 1");
  // 4 (awaiting): live exec + form
  mk("await-live", "<title>a</title><form action='/send'><input name='x'></form>");
  exec("await-live");
  // 3 (reaped, stranded form): exec ended, form still present, no error.txt → reaped NOT awaiting
  mk("stranded", "<title>s</title><form action='/send'><input name='x'></form>");
  exec("stranded");
  setExecutionEnded(db, "stranded", 2000);
  // 3 (reaped via marker): reaped.txt written by reaper
  mk("reaped", "<title>r</title>");
  exec("reaped");
  setExecutionEnded(db, "reaped", 2000);
  writeFileSync(reapedPath(v, "reaped"), "idle\n");
  // 1 (stopped): beats everything including error
  mk("stopped", "<title>st</title><form></form>");
  exec("stopped");
  setExecutionFail(db, "stopped", "x", 2000);
  writeFileSync(stopPath(v, "stopped"), "stopped");
  // 6 (no exec, plain body): unchanged legacy path — no db entry
  mk("noexec", "<title>n</title>");

  const byU = Object.fromEntries(listSessions(v, db).map((s) => [s.uuid, s.status]));
  expect(byU["working"]).toBe("working");
  expect(byU["done"]).toBe("complete");
  expect(byU["failed"]).toBe("error");      // false-green regression: reason!=null NEVER green
  expect(byU["crashed"]).toBe("error");
  expect(byU["await-live"]).toBe("awaiting");
  expect(byU["stranded"]).toBe("reaped");   // stranded-yellow regression: exited form is NOT awaiting
  expect(byU["reaped"]).toBe("reaped");
  expect(byU["stopped"]).toBe("stopped");   // stopped beats error
  expect(byU["noexec"]).toBe("complete");
});

// ── VOS-219: isIdle ──────────────────────────────────────────────────────────

test("isIdle: working + stale activity = true", () => {
  const now = Date.now();
  expect(isIdle("working", now - (IDLE_MS + 10_000), now)).toBe(true);
});

test("isIdle: working + recent activity = false", () => {
  const now = Date.now();
  expect(isIdle("working", now - 30_000, now)).toBe(false);
});

test("isIdle: awaiting is never idle", () => {
  const now = Date.now();
  expect(isIdle("awaiting", now - (IDLE_MS + 10_000), now)).toBe(false);
});

test("isIdle: complete is never idle", () => {
  const now = Date.now();
  expect(isIdle("complete", now - (IDLE_MS + 10_000), now)).toBe(false);
});
