# Issue / Story Schema (gated drain loop)

A **drain unit** is one GitHub Issue. Its body is a task-list of **Boxes**.
The drain loops over the open Boxes until all are checked, then comments
("drained locally, unpushed") and leaves the Issue OPEN (no-push PoC posture).
This file is the single canonical home for the Box grammar — `src/issue.ts`
implements exactly this. Do not redefine it elsewhere.

## Box grammar

Each Box is one GitHub task-list item:

```
- [ ] <title> {gate} {prio}
      <acceptance criteria — one or more indented lines>
```

- `- [ ]` unchecked / `- [x]` checked — the durable done-state, owned by the
  **runner** (via `gh`). The skill never touches the checkbox.
- `<title>` — short imperative summary of the story.
- `{gate}` — REQUIRED. Exactly one of:
  - `auto: <shell-check>` — a machine gate. `<shell-check>` is a command the
    **runner** runs from the worktree root after the skill session exits;
    exit 0 = green. Usually `bun run verify`, may be narrower
    (e.g. `bun test tests/foo.test.ts`).
  - `human` — an async review-as-gate. The skill produces an artifact + a
    markdown review summary into the session's `body.html`; the runner parks
    and the operator gives a verdict in the dashboard agent-inbox.
- `{prio}` — REQUIRED. `p1` (highest) .. `pN`. The **runner** picks the
  highest-priority OPEN Box each iteration and assigns it to the skill.
- Acceptance criteria — indented prose under the Box; the definition-of-done.

## Annotation placement

Gate + priority live in a trailing brace group on the Box title line:

```
- [ ] Add /healthz route returning 200 {auto: bun run verify} {p1}
      Route GET /healthz returns HTTP 200 with body "ok".
- [ ] Polish the dashboard empty-state copy {human} {p3}
      Render an inviting empty-state; needs a human eye on tone.
```

## Drain lifecycle (runner-owned)

1. Runner re-fetches the Issue body, parses Boxes, asserts a clean worktree.
2. Runner picks the highest-priority open Box and assigns it to a fresh skill
   session (cwd = worktree), feeding it the Box + the `progress.txt` tail.
3. Skill works ONLY that Box and exits. It does NOT run the gate, check the
   box, or report an outcome.
4. Runner runs the Box's gate:
   - `auto`: runner runs `<check>`. Green → runner checks the box (`gh`) +
     commits + appends `progress.txt`; loop. Red → re-spawn the same Box with
     the failure fed forward, up to N; still red → terminal `failed`.
   - `human`: runner parks; operator verdict resumes the skill, then the
     runner continues the loop.
5. All Boxes checked → runner comments "drained locally, unpushed", leaves the
   Issue OPEN, deletes `progress.txt`.
