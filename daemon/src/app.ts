/**
 * Build the Hono app with all routes mounted.
 *
 * Split from index.ts so tests can drive `app.fetch` directly without
 * spinning up Bun.serve / binding a port.
 */

import { Hono } from "hono";
import pkg from "../package.json" with { type: "json" };
import { mountApi } from "./api/index.ts";

export const VERSION = pkg.version;

export const buildApp = (): Hono => {
  const app = new Hono();
  app.get("/", (c) => c.text(`void-os daemon v${VERSION}\n`));
  mountApi(app, { version: VERSION });
  return app;
};
