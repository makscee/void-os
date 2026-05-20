# ADR-0008 — Parent-task notification via DB reconcile, not a message queue

- **Status:** Accepted
- **Date:** 2026-05-20
- **Related:** `CONTEXT.md` (Task, Trigger), milestone `dogfood-void-os-workflow`

## Context

void-os runs a tree of Tasks. A parent Task delegates work to child Tasks
asynchronously: the parent fires a child, keeps running, and must be re-driven
("woken") when the child reaches a terminal state so it can read the child's
output as its next Brief message.

Today notification works in two layers:

1. **`tasks` table (SQLite)** — durable. A child writes its terminal state to
   the DB *before* emitting any event. This is the source of truth.
2. **Event bus** — an in-memory, per-process `EventEmitter`. Fire-and-forget:
   no replay, no outbox, no cursor. It does not survive a daemon restart.

The parent-resume path subscribes to the in-memory bus plus a DB recheck
race-guard. This leaves one hole: if the daemon dies while a child is running,
the child's terminal state still lands safely in the DB, but the parent is
parked in `WAITING_ON_AGENT` and never wakes — the in-memory event that would
have driven it is gone, and nothing re-reads the DB on boot.

The obvious "robust" fix is a real message queue (Redis streams, Kafka, or a
DB outbox table with at-least-once delivery). void-os is a single daemon on a
single host; that distribution machinery would be weight carried for a
topology void-os does not have.

## Decision

**The `tasks` table is the queue. Notification is a reconcile loop, not a
message queue.**

1. **Keep the in-memory event bus unchanged.** It is the *fast path* — a
   low-latency wake hint. It is allowed to be lossy.
2. **Parent-resume logic must be fully derivable from DB state.** The wake
   condition is a pure query: a parent in `WAITING_ON_AGENT` whose children
   have all reached a terminal state is ready to resume. No in-memory state is
   load-bearing.
3. **Add a reconcile sweep on daemon boot** (optionally a slow periodic tick
   as belt-and-suspenders): query stuck `WAITING_ON_AGENT` parents, re-fire
   resume from DB. The sweep is idempotent.

The notification's *content* is also durable: the parent's `session_id` and
the child's output both live in the DB, so a reconcile can resume the parent's
Claude session with the child result as its next Brief message.

This is the durable-state + ephemeral-notification pattern (as used by
Kubernetes controllers): reconcile desired-vs-actual from persisted state;
events are only an optimization. The bus can drop every event and the system
still converges on the next sweep.

## Consequences

**Wins**
- Closes the restart hole completely — no parent is permanently stranded.
- No new infrastructure dependency (no Redis/Kafka), no outbox table to keep
  consistent with `tasks`.
- The bus stays simple; its lossiness is no longer a correctness concern, only
  a latency one.

**Costs**
- A parent whose wake event is lost waits until the next sweep, not instantly.
  Acceptable: the bus handles the common case; the sweep is the safety net.
- Does not scale to a multi-daemon / multi-host topology. Accepted — void-os
  is deliberately single-daemon; revisit this ADR if that changes.
