---
name: idea-intake
description: Turn one raw idea into a well-formed task file in the vault backlog.
needs_input: true
input_label: idea
output_target: vault/work/tasks/backlog/*.md
---

# Idea Intake

You receive ONE raw idea (the slash-command argument). Your job is to turn it into a single
well-formed task file in the vault task backlog. Your output is the FILE — do not reply in chat.

## What to do

1. Read the idea text (your input argument). If it is empty or whitespace-only, do NOT invent a
   task — write nothing and stop. (The Stop-hook will nudge once; if still nothing, the run ends
   with produced_change=false. A blank idea is a no-op, not a fabricated task.)

2. Pick a project prefix from the idea. Default to `VOS` if the idea is about void-os itself,
   otherwise choose from the hub code table (ANI/VDN/HMB/ADM/HUB/VAU/VKE/VFL/VBT/VPY/VOS/FBT/WEB/VCD).
   When unsure, use `HUB`.

3. Mint the next free id for that prefix:
   ```bash
   prefix=VOS   # the prefix you chose
   used=$(ls vault/work/tasks/backlog vault/work/tasks/active vault/work/tasks/completed 2>/dev/null \
     | sed -nE "s/^${prefix}-([0-9]+)-.*/\1/p" | sort -n | tail -1)
   next=$(( ${used:-0} + 1 ))
   echo "${prefix}-${next}"
   ```

4. Slugify a short title from the idea: lowercase, spaces to hyphens, strip punctuation, max ~60 chars.

5. Write the file `vault/work/tasks/backlog/<PFX>-<N>-<slug>.md` with EXACTLY this shape:
   ```markdown
   ---
   id: <PFX>-<N>
   title: <one-line human title derived from the idea>
   projects: [<PFX>]
   parent: null
   repos: []
   created: <today YYYY-MM-DD>
   updated: <today YYYY-MM-DD>
   state: backlog
   ---

   ## Why

   <2-4 sentences: what the idea is and why it matters, faithful to the operator's words.>

   ## Done when

   - [ ] <concrete, checkable acceptance bullet 1>
   - [ ] <bullet 2 if warranted>

   ## Log

   - <today YYYY-MM-DD> — created by idea-intake from inbound-bus idea event.
   ```

6. Keep it MINIMAL — this is a backlog seed for the downstream work-flow to pick up, not a full
   plan. Do not add a `## Plan`; planning happens later.
