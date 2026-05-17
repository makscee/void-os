import { z } from "zod";

export const HealthResp = z.object({
  ok: z.literal(true),
  version: z.string(),
  vault_root: z.string(),
  uptime_s: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
});
export type HealthResp = z.infer<typeof HealthResp>;
