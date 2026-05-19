import { describe, test, expect } from "bun:test";
import {
  iconFor,
  tooltipFor,
  statusBarTextFor,
  degradedHeadlineFor,
  degradedBodyFor,
} from "../src/ribbon-state";
import type { DaemonStatus } from "../src/daemon-status";

const RUNNING: DaemonStatus = { state: "running", port: 1, vault: "/v", version: "0" };
const BINARY_MISSING: DaemonStatus = { state: "binary-missing" };
const VAULT_MISMATCH: DaemonStatus = { state: "vault-mismatch", activeVault: "/other" };
const SPAWN_FAILED: DaemonStatus = { state: "spawn-failed", error: "EACCES" };
const DAEMON_DIED: DaemonStatus = { state: "daemon-died" };

describe("ribbon-state", () => {
  test("iconFor maps healthy to circle-dot, degraded to circle-alert", () => {
    expect(iconFor(RUNNING)).toBe("circle-dot");
    expect(iconFor(BINARY_MISSING)).toBe("circle-alert");
    expect(iconFor(VAULT_MISMATCH)).toBe("circle-alert");
    expect(iconFor(SPAWN_FAILED)).toBe("circle-alert");
    expect(iconFor(DAEMON_DIED)).toBe("circle-alert");
  });

  test("tooltipFor returns chat label when healthy, degraded label otherwise", () => {
    expect(tooltipFor(RUNNING)).toBe("void-os chat");
    expect(tooltipFor(BINARY_MISSING)).toBe("void-os degraded — binary not found");
    expect(tooltipFor(VAULT_MISMATCH)).toBe("void-os degraded — another vault is active");
    expect(tooltipFor(SPAWN_FAILED)).toBe("void-os degraded — daemon failed to start");
    expect(tooltipFor(DAEMON_DIED)).toBe("void-os degraded — daemon died");
  });

  test("statusBarTextFor mirrors current healthy label for running, void-os: <state> otherwise", () => {
    expect(statusBarTextFor(RUNNING)).toBe("void-os: connected");
    expect(statusBarTextFor(BINARY_MISSING)).toBe("void-os: binary-missing");
    expect(statusBarTextFor(VAULT_MISMATCH)).toBe("void-os: vault-mismatch");
    expect(statusBarTextFor(SPAWN_FAILED)).toBe("void-os: spawn-failed");
    expect(statusBarTextFor(DAEMON_DIED)).toBe("void-os: daemon-died");
  });

  test("degradedHeadlineFor returns state-specific headline", () => {
    expect(degradedHeadlineFor(BINARY_MISSING)).toBe("Daemon binary not found");
    expect(degradedHeadlineFor(VAULT_MISMATCH)).toBe("Another vault is active");
    expect(degradedHeadlineFor(SPAWN_FAILED)).toBe("Daemon failed to start");
    expect(degradedHeadlineFor(DAEMON_DIED)).toBe("Daemon died");
  });

  test("degradedBodyFor carries raw error for spawn-failed and active vault for vault-mismatch", () => {
    expect(degradedBodyFor(SPAWN_FAILED)).toContain("EACCES");
    expect(degradedBodyFor(VAULT_MISMATCH)).toContain("/other");
    expect(degradedBodyFor(BINARY_MISSING)).toContain("settings"); // hints at fix
  });
});
