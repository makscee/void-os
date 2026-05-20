# ADR-0010 — A Task's output is its final message; the Artifact entity stays dormant in v1

- **Status:** Accepted (premise corrected by VOS-168)
- **Date:** 2026-05-20
- **Related:** `vault/projects/void-os/CONTEXT.md` (canonical glossary), ADR-0009

> **Correction (VOS-168, 2026-05-20).** This ADR originally claimed "no
> Artifact entity in v1". That was inaccurate: migration 0007 already created
> an `artifacts` table and `daemon/src/types/a2a.ts` already defines the A2A
> `Artifact` zod schema. The accurate statement — and the decision that still
> holds — is that **no runtime code reads or writes artifacts**: the table and
> the type are dormant scaffolding. A Task's *effective* output in v1 is its
> final message. The ADR title and body below are corrected accordingly; the
> decision itself is unchanged.

## Context

A parent Task reads a child Task's output, and a sibling Task may reference a
prior Task's output. Both need a concrete notion of "output."

A2A makes output a first-class **Artifact** entity — typed, versioned,
addressable results, distinct from chat Messages. Adopting Artifact would buy:
addressable results, versioning, multiple named outputs per Task, a typed home
for non-text results, provenance, A2A wire interop — and, most importantly, a
precise substrate for Brief assembly (a parent could build a child's Brief by
selecting artifacts by id instead of copying prose).

But void-os already has a durable, shared, addressable result store: the
**Obsidian vault**. A child agent that produces a real result writes a file
into the vault; its final message names the path. Actively using an Artifact
table would duplicate the vault for the result types void-os actually produces
today (prose + vault edits).

An `artifacts` table and an A2A `Artifact` zod type **already exist** in the
codebase (migration 0007, `daemon/src/types/a2a.ts`) — they were scaffolded
when the A2A schema landed. The question this ADR settles is not whether the
entity *exists* but whether v1 *uses* it.

## Decision

**For v1, a Task's output is its final message. The `artifacts` table and the
`Artifact` type stay dormant — no runtime code reads or writes them.**

- A parent resuming reads the child's final message as a Brief message.
- A sibling Task referencing a prior Task resolves the reference to that Task's
  final message.
- Real results live in the vault; the final message names them.
- The dormant `artifacts` table is left in place (removing it is churn for no
  gain); it is simply not wired into any read or write path.

**One forward-compatibility guard is mandatory in v1:** a Task's messages must
be **individually addressable** — every message has an id, history is
queryable. This ensures a future Artifact entity is purely additive ("a
promoted, typed, versioned message") and not a rewrite of how output works.

First-class Artifacts are deferred to the same milestone as the Brief-assembly
engine — their primary payoff (precise Brief construction) only materializes
once that engine exists.

## Consequences

**Wins**
- No artifact rows duplicating the vault; the existing `artifacts` table is
  not maintained as live state.
- v1 stays small — output is just "the last message."
- The messages-addressable guard keeps the door open at near-zero cost.

**Costs**
- Structured or binary results that are not natural vault files have no typed
  home in v1 — they ride inside message text. Accepted: void-os Tasks are agent
  conversations producing prose and vault edits.
- No output versioning in v1 — "the output" is whatever the final turn says.
- A2A Artifact interop is not available until the deferred milestone.
