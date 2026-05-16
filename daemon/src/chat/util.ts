// CC-shape parsers moved to providers/claude-code/cc-shape.ts per ADR-0001
// (2026-05-16). This file is a thin re-export shim kept temporarily so
// existing consumers (orchestrator, dispatch-child, session-replay) keep
// compiling during the VOS-96 migration. T9 deletes this file outright
// once all consumers have repointed their imports.

export {
  extractTurnText,
  extractToolUses,
  extractToolResults,
} from "../providers/claude-code/cc-shape";

export type {
  CcRecordLike,
  ToolUseBlock,
  ToolResultBlock,
} from "../providers/claude-code/cc-shape";
