---
name: skill-author
description: Draft or evolve a vault skill from an intent or learned workflow, and submit it through the gated skill_manage pipeline for operator approval. Use when the user asks to create, change, teach, or set a new behavior or skill.
---

## Instructions

You are the skill authoring entry-point. Given an intent (the user wants a new behavior or wants
to change an existing one), you draft a SKILL.md — and a trigger if bus-bound — and submit it
through the `void-os-skill-manage` MCP server. The gated path is the only path: you NEVER write
`catalog/skills/**` files yourself.

**Step 1 — Clarify the intent into a skill shape.**
Derive from the user's words:
- `name`: a kebab-case slug (e.g. `morning-summary`, `inbox-triage`).
- `description`: one trigger sentence — what the skill does and when to invoke it.
- Bus-bound or invoke-only: bus-bound if it should fire automatically on an inbound event
  (`kind=<something>`); invoke-only if the user calls it explicitly.

**Step 2 — Draft the SKILL.md body.**
Follow the house shape:
```
---
name: <slug>
description: <one-line trigger sentence>
[needs_input: true]        # only if the skill needs a prompt at invocation
[input_label: <label>]
[output_target: <vault-relative-path>]   # only if it writes a file artifact
---

## Instructions

<Concise behavior — what the agent does when this skill runs.>
```
If bus-bound, also draft the trigger body (a one-line markdown file:
`Fires <name> skill on kind=<event>.`).

**Step 3 — Check if the skill exists (new vs. evolve).**
- New skill → use `action: create`.
- Evolving an existing skill → call `skill_view` first to fetch the current body, then:
  - Small tweak: use `action: patch` (pass `old_body` = current body, `body` = new body).
  - Full rewrite: use `action: edit` (pass `body` = new body only).

**Step 4 — Call `skill_manage` via the `void-os-skill-manage` MCP server.**
```
skill_manage({
  action: "create" | "patch" | "edit",
  name: "<slug>",
  body: "<full SKILL.md content>",
  old_body: "<current body>",   // patch only
  trigger: "<trigger body>",    // bus-bound skills only
  exec_id: $VOID_OS_SESSION,
})
```
Use `$VOID_OS_SESSION` as `exec_id` so the decision can be keyed back to this session.

**Step 5 — Report and stop.**
Tell the user:
- The `decisionId` returned.
- That the change is parked and awaiting their approve/reject reply.
- They reply "approve" or "reject" in this session (or in the web UI) — the `skill-manage-apply`
  continuation will activate or drop it; no restart needed.

Important: a skill's content change is a gated mutation. Only operator approval activates it.
Do not poll or proceed further — the operator's reply drives everything from here.
