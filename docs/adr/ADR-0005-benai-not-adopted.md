# ADR-0005 — BenAI features explicitly not adopted

- **Status:** Accepted
- **Date:** 2026-05-18
- **Related spec:** `vault/projects/void-os/specs/2026-05-17-benai-import-findings.md` §4, §3.5

## Context

The `vos-benai-import` milestone evaluated BenAI Agentic OS (Obsidian plugin v3.8.0 by `system3.md`) as a source of import candidates for void-os. Twenty candidate items were triaged in the source spec (§3); some were picked, some deferred, some bundled into other milestones. A separate set of BenAI features were considered and *rejected outright* — those need a durable record so they don't keep re-surfacing as "why don't we just port the BenAI thing?"

This ADR is that record. It complements ADR-0004 (which handles multi-user sharing in depth) by enumerating the rest of the rejected surface area in one place.

## Decision

The following BenAI features are **not adopted** by void-os. Each entry names the specific trigger (if any) that would re-open the question; absence of a trigger means "no foreseeable case."

### 1. Railway-deployed MCP server (`os-mcp`)

BenAI ships an `os-mcp` skill that provisions Relay MCP v2 to the user's own Railway account, with OAuth 2.1 + PocketBase bundled. void-os runs its MCP surface in-process inside the local daemon (see ADR-0002) and self-hosts on tower/mcow via the existing homelab infrastructure when remote access is needed. Paying for Railway as a runtime dependency is the wrong direction for an agent OS that already has a homelab story.

*Re-open trigger:* a void-os user demonstrates a workflow that cannot run on local-daemon or self-host (e.g. cross-device sync with strong availability guarantees) — at which point the shape is "first-party sync," not "lift BenAI's Railway recipe."

### 2. Cowork-only rich-HTML widget (`mcp__visualize__show_widget`)

BenAI's onboarding renders 12-category forms via a custom rich-HTML widget hosted on the Cowork product. The widget is bound to BenAI's hosted infrastructure — there is no path to use it without their backend. void-os covers the same UX surface with the existing `ask_user` MCP tool plus plugin views (see VOS-132 / VOS-133 task lineage in the source spec §3.10, §3.11).

*Re-open trigger:* none. Even if Cowork were openable, the dependency direction is wrong.

### 3. TaskNotes plugin dependency

BenAI's operator and optimizer assume the user has installed the community TaskNotes Obsidian plugin, which provides a task store the BenAI agents read from and write to. void-os tracks work in flat markdown files under `vault/work/tasks/{state}/<ID>.md`, moved between states via `git mv` — see hub's unified workflow. That substrate is platform-neutral, scriptable, and survives plugin churn.

*Re-open trigger:* none. Delegating the task substrate to a third-party Obsidian plugin gives up the kanban-as-git-state property that the unified workflow depends on.

### 4. Solo / Business mode bifurcation in setup

BenAI's `os-setup` skill asks the user to declare Solo or Business mode and then branches the rest of onboarding on that choice (different questions, different generated context files, different operator prompt sections). It doubles the surface area of the onboarding flow for a distinction that maps poorly onto void-os's audience.

*Re-open trigger:* an explicit business-mode void-os user (revenue lines, customer pipeline, team) whose workflow demonstrably cannot be served by the single-mode onboarding. At that point the right move is a second onboarding flow, not a mode flag bolted onto the first.

### 5. Per-revenue-line context files (`services.md`, `pain-points.md`, `icp.md`)

BenAI's Business-mode setup writes a fixed set of revenue-line context files (services rendered, customer pain points, ideal-customer profile, etc.). These shapes are domain-specific to BenAI's consultant / founder audience. void-os does not assume the user is running a service business and does not pre-create vocabulary for one.

*Re-open trigger:* tied to item 4 — only meaningful if a business-mode onboarding ships.

### 6. Relay-based multi-user vault sharing (BenAI Relay fork in `team-os`)

BenAI's `team-os` skill drops a forked Relay plugin into Obsidian, adding RBAC for shared vaults. This is the implementation arm of the multi-user question covered structurally by **ADR-0004**. Listed here for completeness: void-os v1 does not ship, recommend, or depend on the Relay fork.

*Re-open trigger:* same as ADR-0004 — first paying void-os user explicitly requests vault sharing with at least one named collaborator. At that point the implementation question (Relay fork vs first-party sync vs git-as-substrate) is open; ADR-0004 controls the trigger.

## Items handled elsewhere (cross-references, not separate decisions)

The source spec §4 also lists two items that are *not BenAI features rejected* but rather *void-os candidate tasks that the operator chose to skip*. They live in the spec for traceability and are not duplicated here:

- Probe-don't-ask helper extraction (spec §3.17): skipped as standalone task; probe pattern stays inline in VOS-130 (MCP cards). Re-open if a second probe consumer appears.
- Standalone BenAI license-audit task (spec §3.19): skipped as standalone task; the audit-as-inline-process is captured in spec §7. Re-open if a verbatim BenAI port becomes actually pickable.

## Consequences

**Positive.**

- Drive-by "why don't we just port BenAI's X?" lands against this ADR. Each rejected item has a one-paragraph durable answer.
- The void-os surface stays defensible: no Railway dependency, no Cowork dependency, no TaskNotes dependency, no Relay fork to maintain.
- Re-open triggers are named per item — none of these are permanent "no"s, they are deferred decisions with explicit re-debate gates.

**Negative.**

- void-os will read as "less featured" to anyone comparing checkboxes against BenAI. The shape difference is intentional but is not free in marketing terms.

**Reversibility.** Each item is independently revisitable when its named trigger fires. Reversal of any item requires a new ADR superseding this one for that item.

## See also

- ADR-0004 — Multi-user vault sharing: deferred for v1
- Spec: `vault/projects/void-os/specs/2026-05-17-benai-import-findings.md` §4 (origin table for items 1–6), §3.5 (the picked task that produced these ADRs), §7 (license-audit inline process)
