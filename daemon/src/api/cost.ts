// VOS-87 T7: GET /cost/today — returns composite rollup (total + by_task + by_chat).

import type { Hono } from "hono";
import type { ApiContext } from "./index";
import { costsForToday } from "../cost/index";
import { dayRangeMs } from "../cost/tz";

export function mountCost(app: Hono, ctx: ApiContext): void {
  app.get("/cost/today", (c) => {
    const range = dayRangeMs(Date.now(), ctx.tz);
    return c.json(costsForToday(ctx.db, range));
  });
}
