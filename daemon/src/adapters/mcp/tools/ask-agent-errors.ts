export class AskAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskAgentError";
  }
}

export interface McpErrorResult {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
}

export function toMcpError(err: unknown): McpErrorResult {
  const text =
    err instanceof AskAgentError ? err.message :
    err instanceof Error ? `internal: ${err.message}` :
    "internal error";
  return { isError: true, content: [{ type: "text", text }] };
}
