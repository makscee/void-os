// VOS-89 T10: ask_agent MCP tool schema definition.
//
// Mirrors the ask-user.ts pattern (ASK_USER_TOOL_DEF). The dispatch
// handler in adapters/mcp/index.ts also reads task_id / context_id off
// the args at call time (MCP is stateless — there is no per-session
// context on the transport), so we extend `properties` with those IDs
// the same way ask_user does. Only `target_agent_id` and `message` are
// declared required by the spec (plan §T10 lines 1074, 1097).

export const ASK_AGENT_TOOL_DEF = {
  name: "ask_agent",
  description:
    "Ask another agent (in the same Context). The daemon mints a child A2A Task; " +
    "this call suspends until the child reaches a terminal state and returns its " +
    "final assistant text.",
  inputSchema: {
    type: "object" as const,
    properties: {
      target_agent_id: { type: "string", minLength: 1 },
      message: { type: "string", minLength: 1 },
      system_message: { type: "string" },
      // Caller-injected per ask_user precedent. Stateless MCP means we
      // cannot derive these from the transport.
      task_id: { type: "string", minLength: 1 },
      context_id: { type: "string", minLength: 1 },
    },
    required: ["target_agent_id", "message"],
  },
};
