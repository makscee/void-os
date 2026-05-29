// paths.ts — vault + session path resolution (Task 2)
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const sessionsRoot = (vault: string) => join(vault, "sessions");
export const sessionDir = (vault: string, uuid: string) => join(sessionsRoot(vault), uuid);
export const bodyPath = (vault: string, uuid: string) => join(sessionDir(vault, uuid), "body.html");
export const errorPath = (vault: string, uuid: string) => join(sessionDir(vault, uuid), "error.txt");
export const runLogPath = (vault: string, uuid: string, n: number) =>
  join(sessionDir(vault, uuid), `run-${n}.log`);
export const configPath = (vault: string) => join(vault, "void-os.json");
export const vaultRoot = () => process.env.VOID_OS_VAULT ?? join(process.env.HOME ?? "/tmp", ".void-os");

export interface VoidOsConfig {
  vault: string;
  onboarded: boolean;
  skills: string[];
  answers: Record<string, string>;
  port: number;
}

const DEFAULT_PORT = 4317;

export function readConfig(vault: string): VoidOsConfig {
  const p = configPath(vault);
  if (!existsSync(p)) {
    return { vault, onboarded: false, skills: [], answers: {}, port: DEFAULT_PORT };
  }
  const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<VoidOsConfig>;
  return {
    vault: raw.vault ?? vault,
    onboarded: raw.onboarded ?? false,
    skills: raw.skills ?? [],
    answers: raw.answers ?? {},
    port: raw.port ?? DEFAULT_PORT,
  };
}

export function writeConfig(cfg: VoidOsConfig): void {
  writeFileSync(configPath(cfg.vault), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}
