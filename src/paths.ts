// paths.ts — vault + session path resolution (Task 2)
import { join } from "node:path";

export const sessionsRoot = (vault: string) => join(vault, "sessions");
export const sessionDir = (vault: string, uuid: string) => join(sessionsRoot(vault), uuid);
export const bodyPath = (vault: string, uuid: string) => join(sessionDir(vault, uuid), "body.html");
export const errorPath = (vault: string, uuid: string) => join(sessionDir(vault, uuid), "error.txt");
export const runLogPath = (vault: string, uuid: string, n: number) =>
  join(sessionDir(vault, uuid), `run-${n}.log`);
export const configPath = (vault: string) => join(vault, "config.json");
export const vaultRoot = () => process.env.VOID_OS_VAULT ?? join(process.env.HOME ?? "/tmp", ".void-os");
