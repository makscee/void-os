// daemon/src/adapters/mcp/tools/ask-user.ts
import { z } from "zod";

export const AskUserInput = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(80)).max(6).optional(),
});

export type AskUserInputT = z.infer<typeof AskUserInput>;

export const ASK_USER_TOOL_DEF = {
  name: "ask_user",
  description:
    "Pause the current Task and ask the user a question inline in chat. " +
    "Returns the user's answer as the tool result. " +
    "If `options` is provided, the UI shows buttons; the returned text is either the clicked option or free-text reply.",
  inputSchema: {
    type: "object" as const,
    properties: {
      question: { type: "string", minLength: 1, maxLength: 500 },
      options: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 80 },
        maxItems: 6,
      },
    },
    required: ["question"],
  },
};
