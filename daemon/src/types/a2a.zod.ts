// Zod schemas mirroring the TS types in `./a2a.ts`.
//
// Runtime validation surface for incoming A2A payloads. Schemas are NOT
// exported as the canonical type vocabulary — the hand-written types in
// `./a2a.ts` are authoritative. To use a schema:
//
//   import * as a2a from "@/types/a2a.zod";  // via barrel
//   const msg = a2a.MessageSchema.parse(json);
//
// PartSchema enforces the v1.0 member-name discriminator: exactly one of
// {text, raw, url, data} must be present (FilePart is split into raw and
// url branches per Appendix A.2.1).

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums — represented as z.enum over the SCREAMING_SNAKE string values.
// ---------------------------------------------------------------------------

export const TaskStateSchema = z.enum([
  "TASK_STATE_UNSPECIFIED",
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
]);

export const RoleSchema = z.enum(["ROLE_UNSPECIFIED", "ROLE_USER", "ROLE_AGENT"]);

// ---------------------------------------------------------------------------
// Part — exactly-one-of {text, raw, url, data} (member-name discriminator).
//
// Each branch uses `.strict()` against its disallowed sibling discriminators
// so a payload like `{ text: "x", raw: "y" }` is rejected. Other optional
// shared fields (filename, mediaType, metadata) and unknown keys are kept
// permissive (the spec allows forward-compatible extension via metadata).
// ---------------------------------------------------------------------------

const PartCommonFields = {
  filename: z.string().optional(),
  mediaType: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

export const TextPartSchema = z.object({
  text: z.string(),
  raw: z.never().optional(),
  url: z.never().optional(),
  data: z.never().optional(),
  ...PartCommonFields,
});

export const FileRawPartSchema = z.object({
  raw: z.string(),
  text: z.never().optional(),
  url: z.never().optional(),
  data: z.never().optional(),
  ...PartCommonFields,
});

export const FileUrlPartSchema = z.object({
  url: z.string(),
  text: z.never().optional(),
  raw: z.never().optional(),
  data: z.never().optional(),
  ...PartCommonFields,
});

export const DataPartSchema = z.object({
  data: z.record(z.string(), z.unknown()),
  text: z.never().optional(),
  raw: z.never().optional(),
  url: z.never().optional(),
  ...PartCommonFields,
});

export const FilePartSchema = z.union([FileRawPartSchema, FileUrlPartSchema]);

export const PartSchema = z.union([
  TextPartSchema,
  FileRawPartSchema,
  FileUrlPartSchema,
  DataPartSchema,
]);

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export const MessageSchema = z.object({
  messageId: z.string(),
  role: RoleSchema,
  parts: z.array(PartSchema),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
  referenceTaskIds: z.array(z.string()).optional(),
  extensions: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export const ArtifactSchema = z.object({
  artifactId: z.string(),
  parts: z.array(PartSchema),
  name: z.string().optional(),
  description: z.string().optional(),
  extensions: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// TaskStatus / Task
// ---------------------------------------------------------------------------

export const TaskStatusSchema = z.object({
  state: TaskStateSchema,
  message: MessageSchema.optional(),
  timestamp: z.string().optional(),
});

export const TaskSchema = z.object({
  id: z.string(),
  contextId: z.string(),
  status: TaskStatusSchema,
  artifacts: z.array(ArtifactSchema).optional(),
  history: z.array(MessageSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// AgentCard family
// ---------------------------------------------------------------------------

export const AgentExtensionSchema = z.object({
  uri: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const AgentCapabilitiesSchema = z.object({
  streaming: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
  extensions: z.array(AgentExtensionSchema).optional(),
  extendedAgentCard: z.boolean().optional(),
});

export const AgentSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
  securityRequirements: z.array(z.record(z.string(), z.array(z.string()))).optional(),
});

export const AgentInterfaceSchema = z.object({
  url: z.string(),
  protocolBinding: z.string(),
  protocolVersion: z.string(),
  tenant: z.string().optional(),
});

export const AgentProviderSchema = z.object({
  organization: z.string(),
  url: z.string().optional(),
});

export const AgentCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  capabilities: AgentCapabilitiesSchema,
  defaultInputModes: z.array(z.string()),
  defaultOutputModes: z.array(z.string()),
  supportedInterfaces: z.array(AgentInterfaceSchema),
  skills: z.array(AgentSkillSchema),
  provider: AgentProviderSchema.optional(),
  documentationUrl: z.string().optional(),
  iconUrl: z.string().optional(),
  securitySchemes: z.record(z.string(), z.unknown()).optional(),
  securityRequirements: z.array(z.record(z.string(), z.array(z.string()))).optional(),
  signatures: z.array(z.record(z.string(), z.unknown())).optional(),
});
