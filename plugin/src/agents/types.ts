// VOS-92: MIRROR of daemon AgentListEntry — keep in sync.
// (Source of truth: daemon/src/agents/types.ts.)
// Local copy avoids a cross-package import; if you add a field here,
// add it there in the same PR.

export interface AgentListEntry {
  name: string;
  description: string;
}
