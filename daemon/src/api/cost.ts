// VOS-81 T4: GET /cost/today — returns today's cost rollup.

import type { Hono } from "hono";
import type { ApiContext } from "./index";
import { costsForToday } from "../cost/index";

export function mountCost(app: Hono, ctx: ApiContext): void {
  app.get("/cost/today", (c) => c.json(costsForToday(ctx.db)));
}
