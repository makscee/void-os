// paths.ts — vault + session path resolution (Task 2)
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const sessionsRoot = (vault: string) => join(vault, "sessions");
export const sessionDir = (vault: string, uuid: string) => join(sessionsRoot(vault), uuid);
export const bodyPath = (vault: string, uuid: string) => join(sessionDir(vault, uuid), "body.html");
export const errorPath = (vault: string, uuid: string) => join(sessionDir(vault, uuid), "error.txt");
export const runLogPath = (vault: string, uuid: string, n: number) =>
  join(sessionDir(vault, uuid), `run-${n}.log`);
export const pidPath = (vault: string, uuid: string) => join(sessionDir(vault, uuid), "vc.pid");
export const stopPath = (vault: string, uuid: string) => join(sessionDir(vault, uuid), "stopped.txt");
export const configPath = (vault: string) => join(vault, "void-os.json");
export const registryDbPath = (vault: string) => join(vault, ".void-os", "registry.db");
export const hookSettingsDir = (vault: string) => join(vault, ".void-os", "cc");
export const triggersDir = (vault: string) => join(vault, "triggers");
export const inboxPath = (vault: string, name: string) => join(vault, "inbox", `${name}.jsonl`);
export const eventsDir = (vault: string) => join(vault, ".void-os", "events");
export const eventLogPath = (vault: string, execId: string) => join(eventsDir(vault), `${execId}.jsonl`);
export const vaultRoot = () => process.env.VOID_OS_VAULT ?? join(process.env.HOME ?? "/tmp", ".void-os");

export interface Runner {
  label: string;
  command: string; // argv prefix, tokenized on whitespace (e.g. "vc --" or "claude_artem")
}

export interface VoidOsConfig {
  vault: string;
  onboarded: boolean;
  skills: string[];
  answers: Record<string, string>;
  port: number;
  runners: Runner[];
  defaultRunner: string;
}

const DEFAULT_PORT = 4317;
export const DEFAULT_RUNNER_LABEL = "vc (relay)";
export const DEFAULT_RUNNERS: Runner[] = [{ label: DEFAULT_RUNNER_LABEL, command: "vc --" }];

export function readConfig(vault: string): VoidOsConfig {
  const p = configPath(vault);
  if (!existsSync(p)) {
    return { vault, onboarded: false, skills: [], answers: {}, port: DEFAULT_PORT,
      runners: DEFAULT_RUNNERS, defaultRunner: DEFAULT_RUNNER_LABEL };
  }
  const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<VoidOsConfig>;
  const runners = raw.runners && raw.runners.length ? raw.runners : DEFAULT_RUNNERS;
  return {
    vault: raw.vault ?? vault,
    onboarded: raw.onboarded ?? false,
    skills: raw.skills ?? [],
    answers: raw.answers ?? {},
    port: raw.port ?? DEFAULT_PORT,
    runners,
    defaultRunner: raw.defaultRunner ?? runners[0].label,
  };
}

/** Resolve a runner label to its command prefix; falls back to defaultRunner's command. */
export function resolveRunner(cfg: VoidOsConfig, label?: string): string {
  const target = label ?? cfg.defaultRunner;
  const found = cfg.runners.find((r) => r.label === target);
  if (found) return found.command;
  // Fallback: default runner command
  const def = cfg.runners.find((r) => r.label === cfg.defaultRunner);
  return def?.command ?? cfg.runners[0]?.command ?? "vc --";
}

export function writeConfig(cfg: VoidOsConfig): void {
  writeFileSync(configPath(cfg.vault), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}
