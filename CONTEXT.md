# void-os — Context Glossary

The shared language of void-os. Glossary only — no implementation details.

## Agent

A named persona with a system prompt, model, and tools. A static catalogue
entry. An Agent is *who* acts; it does not itself hold conversation state.

Any Agent can run a root Task — there is no special "manager" Agent. What an
Agent may do (which other Agents it can Trigger, what it can touch) is bounded
by its permission scope, not by its position in the tree.

## Task

The tree node. The fundamental unit of work. A Task is stateful (it has a
lifecycle: working → completed/failed/canceled), has its own message history,
produces an output, runs as one Agent, and is powered by one Session. Tasks
form a tree via a parent link. A Task is triggered by a Trigger.

Term adopted from the A2A protocol, where Task is likewise the stateful,
lifecycled unit. An A2A Task is multi-turn — "Task" does not mean
fire-and-forget.

Every Task belongs to one Context. A root Task has no parent (it is triggered
by the operator); every other Task has a parent Task.

One Task is one unit of work handled by one Agent. A parent re-engages an
existing child Task to continue the same job; it spawns a new child Task for a
distinct job. The tree branches on distinct delegated jobs, not on every
message.

### Lifecycle

A Task's state set is A2A's: `submitted`, `working`, `input-required`,
`auth-required`, `completed`, `failed`, `canceled`, `rejected` (plus the
void-os-internal `waiting-on-agent` — a parent blocked on a child; maps to
A2A `working` for external interop).

Multi-turn happens in the non-terminal parked states (`input-required`,
`waiting-on-agent`): the Agent yields, the parent sends another message, the
same Task continues.

The terminal states (`completed`, `failed`, `canceled`, `rejected`) freeze a
Task: it is immutable and is never reopened. Its Session is kept read-only as
the trace. Continuing the theme of a completed Task means spawning a new
sibling Task, not reopening the old one.

The Agent itself declares `completed` — it decides its job is done. A parent
cannot force-complete a child; it can only `cancel` it.

Not to be confused with: a hub `vault/work/` task file (`VOS-NNN`). That is an
unrelated work-tracking artifact.

## Session

The Claude Code session powering one Task — its LLM context window and the
conversation that resumes within it. Implementation detail that lives on a
Task. One Task ↔ one Session.

## Context

A grouping of related Tasks — one ongoing topic or conversation. Thin: it has
an id, a title, and a creation time, and nothing else. No lifecycle, no state
machine — a Context never "completes"; it lives until deleted. Therefore a
Context is perpetual by default: a recurring topic is just a Context you keep
attaching new root Tasks to.

A Context groups one or more root Tasks (and, transitively, their whole
subtrees). It holds no state of its own and powers no Session.

Term adopted from the A2A protocol's `contextId` — likewise a pure grouping
key with no object behind it.

## Trigger

What causes a Task to start. In v1, a Trigger is a message from the parent
Task. The root Task is triggered by the human operator.

## Brief

The LLM input a Task's Session receives. The Trigger message is the *initial*
Brief — its seed. A Task does NOT automatically inherit its parent's message
history; a parent must put into the Brief whatever the child needs. (A Task is
multi-turn, so the Brief grows as the parent sends follow-up messages.)

Distinct from Context: the Brief is what one Task *reads*; Context is how Tasks
are *grouped*.
