// A2A v1.0 protocol data model — TypeScript types.
//
// Source: https://a2a-protocol.org/latest/specification/ (§4 Protocol Data Model)
// Indexed in context-mode under source `a2a-spec`.
//
// Conventions (per A2A §5.5):
//   - All JSON fields are camelCase.
//   - All enum string values are SCREAMING_SNAKE_CASE (ProtoJSON).
//   - Enums modeled as `as const` + `typeof` literal unions (NOT TS `enum`),
//     so JSON serialization is direct and TS `verbatimModuleSyntax` is honored.
//   - `Part` uses v1.0 member-name discrimination — NO `kind` field. Each
//     variant declares its discriminator member, and the union is exactly-one-of
//     among {text, raw, url, data}. The shared `filename`/`mediaType`/`metadata`
//     fields are optional on every variant.
//
// This module is types-only. Runtime validation lives in `a2a.zod.ts`.

// ---------------------------------------------------------------------------
// 4.1.1 TaskState — §4.1.1
// ---------------------------------------------------------------------------

export const TaskState = {
  Unspecified: "TASK_STATE_UNSPECIFIED",
  Submitted: "TASK_STATE_SUBMITTED",
  Working: "TASK_STATE_WORKING",
  Completed: "TASK_STATE_COMPLETED",
  Failed: "TASK_STATE_FAILED",
  Canceled: "TASK_STATE_CANCELED",
  InputRequired: "TASK_STATE_INPUT_REQUIRED",
  Rejected: "TASK_STATE_REJECTED",
  AuthRequired: "TASK_STATE_AUTH_REQUIRED",
} as const;
export type TaskState = (typeof TaskState)[keyof typeof TaskState];

// ---------------------------------------------------------------------------
// 4.1.5 Role — §4.1.5
// ---------------------------------------------------------------------------

export const Role = {
  Unspecified: "ROLE_UNSPECIFIED",
  User: "ROLE_USER",
  Agent: "ROLE_AGENT",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

// ---------------------------------------------------------------------------
// 4.1.6 Part — §4.1.6, Appendix A.2.1 (member-name discriminator, v1.0)
// ---------------------------------------------------------------------------

/** Shared optional fields permitted on every Part variant. */
export interface PartCommon {
  filename?: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

/** Plain text part. Discriminator: presence of `text`. */
export interface TextPart extends PartCommon {
  text: string;
}

/** File part — inline bytes (`raw`) variant. Discriminator: presence of `raw`. */
export interface FileRawPart extends PartCommon {
  raw: string;
}

/** File part — by-reference (`url`) variant. Discriminator: presence of `url`. */
export interface FileUrlPart extends PartCommon {
  url: string;
}

/** Combined File part — exactly one of `raw` | `url`. */
export type FilePart = FileRawPart | FileUrlPart;

/** Structured-data part. Discriminator: presence of `data`. */
export interface DataPart extends PartCommon {
  data: Record<string, unknown>;
}

/**
 * v1.0 Part discriminated union. Member name is the discriminator:
 *   {text}                → TextPart
 *   {raw,  filename?, mediaType?}  → FileRawPart
 *   {url,  filename?, mediaType?}  → FileUrlPart
 *   {data}                → DataPart
 *
 * Exactly one of {text, raw, url, data} MUST be set; runtime enforcement
 * lives in PartSchema (a2a.zod.ts).
 */
export type Part = TextPart | FileRawPart | FileUrlPart | DataPart;

// ---------------------------------------------------------------------------
// 4.1.4 Message — §4.1.4
// ---------------------------------------------------------------------------

export interface Message {
  messageId: string;
  role: Role;
  parts: Part[];
  contextId?: string;
  taskId?: string;
  referenceTaskIds?: string[];
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 4.1.7 Artifact — §4.1.7
// ---------------------------------------------------------------------------

export interface Artifact {
  artifactId: string;
  parts: Part[];
  name?: string;
  description?: string;
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 4.1.2 TaskStatus / 4.1.3 Task — §4.1.2, §4.1.3
// ---------------------------------------------------------------------------

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  /** ISO 8601 timestamp string, e.g. "2023-10-27T10:00:00Z". */
  timestamp?: string;
}

export interface Task {
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 4.4.3 AgentCapabilities — §4.4.3
// ---------------------------------------------------------------------------

export interface AgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extensions?: AgentExtension[];
  extendedAgentCard?: boolean;
}

// ---------------------------------------------------------------------------
// 4.4.5 AgentSkill — §4.4.5
// ---------------------------------------------------------------------------

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  securityRequirements?: Array<Record<string, string[]>>;
}

// ---------------------------------------------------------------------------
// 4.4.6 AgentInterface — §4.4.6
// ---------------------------------------------------------------------------

export interface AgentInterface {
  url: string;
  protocolBinding: string;
  protocolVersion: string;
  tenant?: string;
}

// ---------------------------------------------------------------------------
// 4.4.4 AgentProvider — §4.4.4
// ---------------------------------------------------------------------------

export interface AgentProvider {
  organization: string;
  url?: string;
}

// ---------------------------------------------------------------------------
// 4.4.1 AgentCard — §4.4.1
// ---------------------------------------------------------------------------

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  capabilities: AgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  supportedInterfaces: AgentInterface[];
  skills: AgentSkill[];
  provider?: AgentProvider;
  documentationUrl?: string;
  iconUrl?: string;
  securitySchemes?: Record<string, unknown>;
  securityRequirements?: Array<Record<string, string[]>>;
  signatures?: Array<Record<string, unknown>>;
}
