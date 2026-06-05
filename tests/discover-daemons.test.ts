import { expect, test } from "bun:test";
import {
  parseLsofListeners, classifyStale, isKillableDaemon, discoverDaemons,
  type DaemonInfo,
} from "../src/discover-daemons.ts";

// --- parseLsofListeners: pid+port from `lsof -nP -iTCP -sTCP:LISTEN` output ---
test("parseLsofListeners extracts {pid,port} from lsof LISTEN lines", () => {
  const out = [
    "COMMAND   PID  USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME",
    "bun     12345 admin  20u  IPv4  0xabc      0t0  TCP *:4317 (LISTEN)",
    "bun     12345 admin  21u  IPv6  0xdef      0t0  TCP *:4317 (LISTEN)", // dup pid+port
    "rapportd  475 admin   9u  IPv4  0x111      0t0  TCP 127.0.0.1:62241 (LISTEN)",
  ].join("\n");
  const got = parseLsofListeners(out);
  // dedup on pid+port; both 4317 rows collapse to one
  expect(got).toContainEqual({ pid: 12345, port: 4317 });
  expect(got).toContainEqual({ pid: 475, port: 62241 });
  expect(got.filter((l) => l.port === 4317).length).toBe(1);
});

test("parseLsofListeners ignores non-LISTEN / malformed lines", () => {
  expect(parseLsofListeners("garbage\n\n")).toEqual([]);
});

// --- classifyStale: same-vault vs different-vault ---
const mk = (vault: string, port: number, pid = 9): DaemonInfo => ({ vault, port, pid });

test("classifyStale: daemon on a DIFFERENT vault is stale wrt target vault", () => {
  expect(classifyStale(mk("/abs/other", 4317), "/abs/target").stale).toBe(true);
});

test("classifyStale: daemon on the SAME resolved vault is NOT stale", () => {
  expect(classifyStale(mk("/abs/target", 4317), "/abs/target").stale).toBe(false);
});

// --- isKillableDaemon: only void-os daemons, never self ---
test("isKillableDaemon: a discovered void-os daemon (pid != self) is killable", () => {
  expect(isKillableDaemon(mk("/abs/v", 4317, 12345), /*selfPid*/ 999)).toBe(true);
});

test("isKillableDaemon: NEVER kill the current process", () => {
  expect(isKillableDaemon(mk("/abs/v", 4317, 4242), /*selfPid*/ 4242)).toBe(false);
});

test("isKillableDaemon: reject a bogus/non-positive pid", () => {
  expect(isKillableDaemon(mk("/abs/v", 4317, 0), 999)).toBe(false);
  expect(isKillableDaemon(mk("/abs/v", 4317, 1), 999)).toBe(false); // never signal init
});

// --- discoverDaemons: lsof listeners → probe /whoami → only void-os answers survive ---
test("discoverDaemons keeps only listeners that answer /whoami with a valid shape", async () => {
  const listeners = [{ pid: 100, port: 4317 }, { pid: 200, port: 62241 }];
  const probe = async (port: number): Promise<DaemonInfo | null> =>
    port === 4317 ? { vault: "/abs/v", port: 4317, pid: 100 } : null; // 62241 = foreign
  const got = await discoverDaemons({
    listListeners: async () => listeners,
    probe,
  });
  expect(got).toEqual([{ vault: "/abs/v", port: 4317, pid: 100 }]);
});
