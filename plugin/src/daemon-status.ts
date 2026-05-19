/** Lifecycle-phase status published on the Plugin instance. Surfaced by the
 *  settings tab and by E2E specs so they can assert the plugin's view of the
 *  daemon without polling the HTTP layer directly. Pure type module — no
 *  Obsidian imports so unit tests can consume it under Bun. */
export type DaemonStatus =
  | { state: "running"; port: number; vault: string; version: string }
  | { state: "binary-missing" }
  | { state: "vault-mismatch"; activeVault: string }
  | { state: "spawn-failed"; error: string }
  | { state: "daemon-died" };
