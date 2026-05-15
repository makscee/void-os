import { describe, test, expect } from "bun:test";
import { AskAgentError, toMcpError } from "../../../../src/adapters/mcp/tools/ask-agent-errors";

describe("AskAgentError", () => {
  test("preserves message", () => {
    const e = new AskAgentError("unknown agent: journaler");
    expect(e.message).toBe("unknown agent: journaler");
    expect(e.name).toBe("AskAgentError");
  });
  test("toMcpError shapes an isError content block", () => {
    const result = toMcpError(new AskAgentError("permission denied"));
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "permission denied" }]);
  });
  test("toMcpError wraps non-AskAgentError as generic", () => {
    const result = toMcpError(new Error("boom"));
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe("text");
  });
});
