import { z } from "zod";

export const AgentListEntry = z.object({
  name: z.string().min(1),
  description: z.string(),
});
export type AgentListEntry = z.infer<typeof AgentListEntry>;

export const AgentsListResp = z.object({
  agents: z.array(AgentListEntry),
});
export type AgentsListResp = z.infer<typeof AgentsListResp>;
