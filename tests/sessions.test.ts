import { expect, test, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
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
});

test("sorts newest body.html first, extracts title, flags errors", () => {
  const s = listSessions(vault);
  expect(s.map((x) => x.uuid)).toEqual(["new", "broken", "old"]);
  expect(s[0].title).toBe("new session");
  expect(s.find((x) => x.uuid === "broken")!.error).toBe(true);
  expect(s.find((x) => x.uuid === "new")!.error).toBe(false);
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
