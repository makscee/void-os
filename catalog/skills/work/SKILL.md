---
name: work
description: Execute a task file in the vault and mutate it to a done/result state.
needs_input: true
input_label: task file path
output_target: vault/work/tasks/active/*.md
---

# Work

You receive ONE task file path (the slash-command argument). Your job is to execute the task
described in that file and mutate the file to reflect the outcome. Your output is the FILE
mutation — do not reply in chat without also mutating the task file.

## What to do

1. Read the task file at the given path. If the path is empty or the file does not exist, write
   nothing and stop. (The Stop-hook will nudge once; if still nothing, the run ends with
   produced_change=false.)

2. Understand what the task asks for. The `## Done when` section lists the acceptance criteria;
   `## Plan` (if present) lists the steps.

3. Execute the task. All work is vault-scoped: read and write files under the current working
   directory (the vault, `~/void/`). Out-of-vault code work (worktrees, git branches, deploys)
   is OUT of scope for this skill — the task must be vault-only work.

4. When done, append a `## Result` section to the task file with:
   ```markdown
   ## Result

   - completed: <YYYY-MM-DD>
   - outcome: <one-sentence summary of what was done>
   ```
   Then update the frontmatter line `updated: <YYYY-MM-DD>` to today's date.

5. HARD RULE: you MUST mutate the task file before stopping. A run that does the work but
   does not write `## Result` to the task file has NOT produced the required output_target
   change and the Stop-hook will nudge you. Append the section even if the work was minimal.

6. Keep the mutation minimal — only append `## Result` and bump `updated:`. Do not rewrite the
   whole file or add new planning sections.
