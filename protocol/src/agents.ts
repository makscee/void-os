import { z } from "zod";

export const AgentListEntry = z.object({
  name: z.string().min(1),
  description: z.string(),
  // VOS-153: optional rich-presentation fields surfaced from agent.md
  // frontmatter. Plugin chat UI uses these to render per-agent color,
  // avatar glyph, and tagline; absence is normal (backwards compat).
  color: z.string().optional(),
  avatar: z.string().optional(),
  tagline: z.string().optional(),
});
export type AgentListEntry = z.infer<typeof AgentListEntry>;

export const AgentsListResp = z.object({
  agents: z.array(AgentListEntry),
});
export type AgentsListResp = z.infer<typeof AgentsListResp>;
