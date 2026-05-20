import type { MiddlewareHandler } from "hono";

// Browser origins are rejected by default. To allow specific browser callers
// (e.g. a future web UI), add their origin string to this set.
const ALLOWED_ORIGINS = new Set<string>();

function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/);
  return m ? m[1]!.trim() : null;
}

export function makeRequireAuth(expectedToken: string): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return c.json({ error: "E_BAD_ORIGIN" }, 403);
    }
    const supplied =
      bearerFrom(c.req.header("Authorization")) ?? c.req.query("token");
    if (supplied !== expectedToken) {
      return c.json({ error: "E_UNAUTHORIZED" }, 401);
    }
    await next();
  };
}
