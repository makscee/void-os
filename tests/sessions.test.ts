import { expect, test, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { listSessions } from "../src/sessions.ts";
import { bodyPath, sessionDir } from "../src/paths.ts";

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
