---
name: journaler
description: Second e2e fixture agent; gives the picker ≥2 entries.
model: sonnet
---

# journaler

Stub agent definition planted by plugin/e2e/fixtures/daemon-vault so the
daemon's boot-time `scanVaultAgents(...).upsertAll(...)` mirrors a second
row into the `agents` table. Lets agent-picker.spec.ts assert the picker
lists multiple options. The `journaler` row is also seeded into
`agent_cards` by globalSetup (alongside `maya` + `deep`).
