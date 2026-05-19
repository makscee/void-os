# `_templates/` — first-class template folder

This folder holds the canonical shape of every recurring artifact in the
vault. Templates exist so that:

1. **One edit ripples everywhere.** Customise a template once and every agent
   that writes that artifact picks up the new shape on its next render.
2. **Agent prompts stay small.** Agents reference templates by name rather
   than baking the full markdown into their `agent.md`. Cleaner prompt, no
   silent drift between the intended shape and what actually gets written.
3. **Per-vault customisation is trivial.** This vault overrides the seed
   template; downstream vaults can do the same without forking the daemon.

## How agents load templates

Templates load through the `vault.load_template` MCP tool (VOS-131):

| Arg | Required | Meaning |
|---|---|---|
| `name` | yes | Template stem. `vault.load_template({name: "daily"})` reads `_templates/daily.md`. |
| `context` | no | If absent, returns the raw template + slot inventory (inspect mode). If present, substitutes `{{slot}}` markers and returns the rendered text. |
| `allow_missing` | no | When `true`, slots referenced in the template but absent from `context` substitute as empty string instead of erroring. Default `false` — fail-closed. |

Slot syntax is `{{slot_name}}`. Slot names may contain letters, digits,
underscore, dot, and dash (`{{task.id}}`, `{{due-date}}` are valid).
Substitution is one-pass and non-recursive: a substituted value containing
`{{...}}` is NOT re-scanned.

## What lives here

Each template is exactly one file: `_templates/<name>.md`. No nesting, no
per-agent subfolders. The slot inventory lives inside the template itself —
no separate schema file.

Seed inventory (extend on demand, prune when unused):

| Template | When to use | Required slots |
|---|---|---|
| `daily.md` | A new day's journal entry. | `date` |
| `task.md` | A new work ticket under `work/tasks/`. | `id`, `title`, `created` |
| `agent.md` | A new agent draft under `agents/<name>/`. | `name`, `description`, `model` |

## When to add a new template

Add a template when **two or more agents** write the same artifact shape, or
when one agent writes the artifact often enough that drift between rendered
copies has become a real problem. Avoid pre-emptive templates — the cost is
the cognitive load of remembering they exist.

When you DO add one, append a row to the inventory table above and update
any agent that should now load instead of inlining.

## What does NOT belong here

- **Skill definitions, agent prompts, framework references.** Those live in
  `agents/`, `pages/`, or per-folder CLAUDE.md files. Templates are for
  artifacts agents write; instructional content is not an artifact.
- **One-shot scaffolds.** If you'd only ever render the template once, just
  write the file directly. Templates earn their place by being rendered many
  times.

## Operator override

The operator may edit any file under `_templates/` at any time. Agents pick
up the change on their next `vault.load_template` call — no daemon restart,
no cache invalidation.
