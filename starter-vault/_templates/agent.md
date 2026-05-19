---
name: {{name}}
description: {{description}}
model: {{model}}
version: "0.1"
cross_agent:
  ask: false
  handoff: false
read_scope: ['**']
write_scope: []
skills: []
tools:
  - vault.read
---

# {{name}}

<!--
  This is the system prompt loaded into every chat with {{name}}.
  Keep it focused: who the agent is, what it owns, what it doesn't.
  Edits hot-reload on the next message — no daemon restart.
-->

{{description}}

## Scope

<!-- What this agent owns. Mirror the `write_scope` frontmatter in prose. -->

## Out of scope

<!-- What this agent must NOT do. When asked, propose the right specialist. -->

## Voice

<!-- One line on tone. Brief beats clever. -->
