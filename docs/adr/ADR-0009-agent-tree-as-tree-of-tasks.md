# ADR-0009 — The agent tree is a tree of Tasks

- **Status:** Accepted
- **Date:** 2026-05-20
- **Related:** `CONTEXT.md`, ADR-0008, milestone `dogfood-void-os-workflow`

## Context

void-os runs agents that delegate to other agents. The target model is a tree:
a top-level session manages a nested tree of agents; each node has its own LLM
session and message history; a node is triggered by a message from its parent.
We needed one anchor entity for the tree node, and a consistent vocabulary.

The codebase already carried overlapping, half-aligned concepts: a `contexts`
table (formerly "chats"), a `tasks` table with `parent_task_id`, `session_id`
on the context. "Chat", "context", "task", "session", "run" were used loosely.

An industry survey of multi-agent frameworks (A2A, Claude/MCP, OpenAI Agents
SDK, LangGraph) showed a consistent split: A2A's stateful, lifecycled unit of
work is the **Task**; conversation grouping is **Context** (`contextId`, a pure
key with no object behind it); the LLM context window is a **session**
implementation detail. "Chat"/"conversation" are UI words no framework uses for
the orchestration node.

## Decision

**Model the running system as a tree of Tasks.** The vocabulary is fixed in
`CONTEXT.md`; the load-bearing decisions:

1. **Task is the tree node.** It is the stateful, lifecycled unit — own state
   machine, own message history, own output, one Agent, one Session. The tree
   is built by `parent_task_id`. Term and lifecycle adopted from A2A.

2. **Context is a thin grouping, perpetual by default.** `id` + `title` +
   `created_at`, no lifecycle, no state, powers no Session. It groups one or
   more root Tasks (and their subtrees). A Context never completes — a
   recurring topic is just a Context you keep attaching new root Tasks to.

3. **Session moves onto Task.** The Claude Code session (and the Agent
   assignment) belong to the Task, not the Context. The `contexts` table sheds
   `agent`, `session_id`, `current_run_id`; these become Task fields.

4. **A Trigger starts a Task; the Trigger message is the initial Brief.** A
   child Task is triggered by a message from its parent; the root Task by the
   operator. A Task does not inherit its parent's history — the Brief is only
   what the parent explicitly puts in it.

5. **One Task = one unit of work by one Agent.** The tree branches on distinct
   delegated jobs, not on every message. Re-engaging a parked child continues
   the same job; a new job is a new child Task.

### Alternatives rejected

- **"Chat" as the node.** "Chat" is a UI word with no lifecycle; nothing in the
  industry models the orchestration node that way. Rejected — kept only as an
  informal UI label for a Task.
- **Context 1:1 with its root Task (drop Context entirely).** Simpler by one
  entity, but the operator wants to spin up several independent root Tasks
  under one ongoing topic. Keeping Context (A2A-aligned) buys that for the cost
  of one thin row.
- **Task as a tree of `contextId`s.** Rejected — `contextId` has no lifecycle;
  it cannot be the stateful node.

## Consequences

**Wins**
- One anchor entity, A2A-aligned — minimal translation if void-os ever exposes
  or consumes A2A endpoints.
- The tree is self-describing via `parent_task_id`; navigation is plain queries.
- Perpetual topics fall out for free from a lifecycle-less Context.

**Costs**
- A schema migration: `contexts` sheds `agent`/`session_id`/`current_run_id`,
  `tasks` gains them. Existing rows must be migrated.
- "Task" can read as fire-and-forget to newcomers. Mitigation: `CONTEXT.md`
  states explicitly that a Task is multi-turn (A2A `input-required`).
- `run` is demoted to a turn-marker tag on messages, not a tree entity. Anyone
  expecting a first-class Run must consult `CONTEXT.md`.
