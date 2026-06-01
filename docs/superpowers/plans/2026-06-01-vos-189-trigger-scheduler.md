# void-os Trigger Primitive — Phase 2 (VOS-189)

Builds on the phase-1 Run substrate (VOS-188). Adds **Triggers** — scheduled, manual, and event-driven Run launchers — plus a per-Trigger runaway step-ceiling guard.

---

## Trigger file format

Triggers live as markdown files with YAML frontmatter at `vault/triggers/<name>.md`.
The filename stem (`<name>`) is the Trigger's stable identifier.

```markdown
---
kind: schedule          # manual | schedule | event
skill: morning-report   # slash-command name (without /)
agent: default          # agent label
cron_expr: "0 9 * * *"  # schedule only — 5-field cron (UTC)
inbox: avito            # event only — inbox name
step_ceiling: 50        # optional; default 50 (see Runaway guard below)
---
Optional human-readable body (ignored by the daemon).
```

### Kinds

| Kind | Required fields | Fires when |
|---|---|---|
| `manual` | `skill`, `agent` | `void-os trigger-fire <name>` command |
| `schedule` | `skill`, `agent`, `cron_expr` | Daemon tick fires at each cron occurrence |
| `event` | `skill`, `agent`, `inbox` | A line is appended to `vault/inbox/<inbox>.jsonl` |

### Defaults

- `step_ceiling` defaults to `50` when omitted.
- Cron expressions are 5-field standard cron (`"0 9 * * *"` = 09:00 UTC daily). Interpreted in UTC.

---

## Registry projection

The daemon reconciles Trigger files into a `triggers` SQLite table on boot and every 30 seconds:

| Column | Meaning |
|---|---|
| `name` | Filename stem — stable ID |
| `kind` | `manual`/`schedule`/`event` |
| `skill`, `agent`, `cron_expr`, `inbox`, `step_ceiling` | Mirrors file |
| `enabled` | 1 = active (default); 0 = paused |
| `next_fire_at` | Next scheduled epoch-ms (schedule only) |
| `last_fired_at` | Epoch-ms of last fire |

Editing a file reconciles its row. `last_fired_at` and `enabled` are preserved across re-reconciliation.

---

## Firing a Trigger

All three kinds funnel through `fireTrigger()`, which:
1. Calls `spawnRun()` with the Trigger's `skill`, `agent`, `triggerId`, and `stepCeiling`.
2. Stamps `last_fired_at` on the registry row.
3. For schedules: recomputes `next_fire_at` to the next cron occurrence.

### Manual fire

```bash
void-os trigger-fire <name>
```

POSTs to `http://127.0.0.1:<port>/triggers/<name>/fire`. Returns `{"runId":"..."}` on success.

---

## Event inbox

Event Triggers watch an append-only JSONL file at `vault/inbox/<inbox>.jsonl`.

Each line is one event. The daemon drains new lines on every tick (30s) and fires the bound Trigger once per line, passing the line as input to the spawned Run.

### Reference stub adapter

`scripts/vos-inbox-append.sh` appends one JSON line to an inbox:

```bash
scripts/vos-inbox-append.sh <vault> <inbox> '<json-line>'
# e.g.:
scripts/vos-inbox-append.sh ~/void-os demo '{"msg":"hello"}'
```

Real adapters (Telegram, Avito) are deferred — this proves the event Trigger path.

**Note:** Offsets are in-memory. A daemon restart re-reads from byte 0. De-duplication on restart is deferred.

---

## Runaway step-ceiling guard

Every tool invocation (Bash, Read, Edit, etc.) in a Trigger-fired Run fires a `PreToolUse` CC hook that increments `runs.step_count`. When `step_count >= step_ceiling`:

1. The daemon calls `tmux kill-session` on the Run's session.
2. The run row is set to `exited_fail` with `reason = "runaway-ceiling"`.

**Interactive Runs are exempt** — `runs.step_ceiling` is NULL for non-Trigger Runs; the counter is a no-op.

`--max-turns` is NOT used: void-os Runs are interactive (no `-p` flag), so CC's `--max-turns` applies only to headless `--print` mode and is not wired here. The hook-bridge counter is the sole enforcement.

---

## Example Trigger files

**Schedule (daily morning report at 09:00 UTC):**
```markdown
---
kind: schedule
skill: morning-report
agent: default
cron_expr: "0 9 * * *"
step_ceiling: 80
---
```

**Manual (fire on demand):**
```markdown
---
kind: manual
skill: deep-research
agent: default
step_ceiling: 100
---
```

**Event (fire on inbox line):**
```markdown
---
kind: event
skill: triage-inbox
agent: default
inbox: avito
step_ceiling: 40
---
```
