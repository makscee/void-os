---
name: maya
description: Default void-os agent for e2e fixture vault.
model: opus
---

# maya

Stub agent definition planted by plugin/e2e/fixtures/daemon-vault so the
daemon's boot-time `scanVaultAgents(...).upsertAll(...)` mirrors at least
one agent into the `agents` table. Without this the agent picker opened
by `new-chat-btn` shows the empty notice ("No agents in vault/agents/")
and `pickerInput.press("Enter")` is a no-op — blocking ask_user e2e.
