import { z } from "zod";

const HelloData = z.object({ chat_id: z.string(), version: z.string() });
const TextData = z.object({ run_id: z.string(), delta: z.string() });
const ToolUseData = z.object({ run_id: z.string(), name: z.string(), input: z.unknown() });
const ToolResultData = z.object({ run_id: z.string(), name: z.string(), ok: z.boolean() });
const AskUserData = z.object({ run_id: z.string(), task_id: z.string(), prompt: z.string(), options: z.array(z.string()).optional() });
const UsageData = z.object({ run_id: z.string(), input_tokens: z.number(), output_tokens: z.number(), cost_usd: z.number() });
const RunEndData = z.object({ run_id: z.string(), status: z.string() });
const ErrorData = z.object({ message: z.string() });

export const StreamFrame = z.discriminatedUnion("event", [
  z.object({ event: z.literal("hello"), data: HelloData }),
  z.object({ event: z.literal("text"), data: TextData }),
  z.object({ event: z.literal("tool_use"), data: ToolUseData }),
  z.object({ event: z.literal("tool_result"), data: ToolResultData }),
  z.object({ event: z.literal("ask_user"), data: AskUserData }),
  z.object({ event: z.literal("usage"), data: UsageData }),
  z.object({ event: z.literal("run_end"), data: RunEndData }),
  z.object({ event: z.literal("error"), data: ErrorData }),
]);
export type StreamFrame = z.infer<typeof StreamFrame>;
