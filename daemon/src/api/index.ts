// HTTP + WS API server. Routes plugin requests to chat/worker/skills/etc.
// T5 owns health endpoint logic + Hono wiring.

import type { Hono } from "hono";

export interface ApiServer {
  attach(app: Hono): void;
  start(port: number): Promise<void>;
  stop(): Promise<void>;
}

export const createApiServer = (): ApiServer => {
  throw new Error("not implemented");
};
