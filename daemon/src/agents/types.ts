// VOS-92: shared types for the agent registry.
//
// AgentRow is the sqlite row shape (PK + frontmatter mirror).
// AgentListEntry is the wire shape served by GET /agents.
// AgentListEntry is intentionally NOT the A2A AgentCard — the latter
// requires capabilities/skills/defaultInputModes/etc. and is deferred
// to the future ticket that ships .void/cards/*.json.

export interface AgentRow {
  /** PK; matches folder name + frontmatter `name`. */
  name: string;
  description: string;
  model: string;
  /** Absolute path to the agent.md file. */
  vault_path: string;
  /** ms epoch — set at scan time (not file mtime). */
  updated_at: number;
  // VOS-153: optional presentation fields from agent.md frontmatter.
  // Absent (undefined) when the agent file does not set them. Persisted
  // as nullable TEXT columns in the `agents` table (migration 0015).
  color?: string;
  avatar?: string;
  tagline?: string;
}

export interface AgentListEntry {
  name: string;
  description: string;
  color?: string;
  avatar?: string;
  tagline?: string;
}
