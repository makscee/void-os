import { readFileSync, existsSync } from "node:fs";
import { makeClient, type Client, UnreachableError } from "@voidos/protocol";
import { tokenPath, portPath } from "./state-dir.ts";

export class NoTokenError extends Error {
  readonly name = "NoTokenError" as const;
  constructor() {
    super("no daemon token at ~/.void-os/token; run `void-os daemon start`");
  }
}

export function resolveBase(): string {
  if (process.env.VOID_OS_BASE) return process.env.VOID_OS_BASE;
  const pp = portPath();
  if (existsSync(pp)) {
    const port = readFileSync(pp, "utf8").trim();
    if (/^\d+$/.test(port)) return `http://127.0.0.1:${port}`;
  }
  return "http://127.0.0.1:7777";
}

export function resolveToken(): string {
  if (process.env.VOID_OS_TOKEN) return process.env.VOID_OS_TOKEN;
  const tp = tokenPath();
  if (!existsSync(tp)) throw new NoTokenError();
  return readFileSync(tp, "utf8").trim();
}

export function buildClient(): Client {
  return makeClient({ base: resolveBase(), token: resolveToken() });
}

export { UnreachableError };
