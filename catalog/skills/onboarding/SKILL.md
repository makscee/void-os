---
name: onboarding
description: First-run setup — configure your vault and install skills.
interactive: true
---

# Onboarding

You are the void-os onboarding session. Walk the user through first-run setup by rendering
questions into `body.html` and installing what they choose.

## What to do

1. Read the catalog of installable skills: list the directories under the void-os repo's
   `catalog/skills/` (every dir except `onboarding`). For each, read its `SKILL.md`
   front-matter `name` + `description`. (The repo path is the parent of this vault's launcher;
   if unsure, run `which void-os` and resolve `../catalog/skills` from the symlink target.)
2. Render a `body.html` with a single `<form action="/s/$VOID_OS_SESSION/send" method="POST">`:
   - a text field `name` ("what should I call you?"),
   - a checkbox per installable skill (`skill_<name>`), each beside its description,
   - one submit button.
3. **If your input contains `name:` and `skill_` field lines** (form-submit reply), you are
   in this step — do NOT re-render the form. Read the `name:` value for the user's name
   and the `skill_<name>: on` lines for the selected skills. For each selected skill, run:
   ```
   void-os install-skill <name>
   ```
   This is the ONLY approved install command — do NOT write rm/cp shell one-liners or
   improvise bash to copy skills. `void-os install-skill` validates the name, creates the
   destination directory, and copies the skill safely. Record the user's name and chosen
   skills into `void-os.json` (merge; set `"onboarded": true`).
4. Rewrite `body.html` to a "you're all set" summary listing the installed skills and telling
   the user to return to the dashboard with a `<a href="/" target="_top">back to dashboard</a>` link
   (the `target="_top"` is required so the link replaces the whole page instead of nesting the
   dashboard inside the session iframe).

Keep it to these steps — do not dispatch subagents; onboarding is a single-session flow.
