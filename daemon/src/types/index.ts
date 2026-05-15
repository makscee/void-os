// Types barrel. Hand-written A2A types are the authoritative vocabulary;
// Zod schemas are namespaced under `a2a` to avoid name collisions with
// the type identifiers (e.g. `Message` the type vs `MessageSchema` the
// runtime validator).
//
// Usage:
//   import type { AgentCard, Message, Part } from "@/types";
//   import { a2a } from "@/types";
//   const msg = a2a.MessageSchema.parse(json);

export * from "./a2a";
export * as a2a from "./a2a.zod";
