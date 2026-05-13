Daemon source. See VOS-72.

## CC spawner (VOS-73)

The daemon spawns Claude Code subprocesses via `claudev` and streams their
events into the SQLite event log. See
`docs/superpowers/specs/2026-05-13-vos-73-cc-spawner-design.md` for the design.

### Usage

```ts
import { openDatabase } from "./src/adapters/sqlite/index.js";
import { createEventBus } from "./src/events/index.js";
import { createCcSpawner } from "./src/adapters/cc/index.js";

const db   = openDatabase("/path/to/state.sqlite");
const bus  = createEventBus({ db });
const cc   = createCcSpawner({ bus, db, tracesDir: "/path/to/traces" });

const proc = await cc.spawn({
  prompt: "do the thing",
  agent: "maya",
  cwd: "/some/dir",
  chatId: "chat-123",
  // resumeFrom: <prior session_id>,
  // outputTimeoutMs: 120_000,   // idle-between-events, default 120s
  // toolTimeoutMs: 1_800_000,   // in-tool-call, default 30 min
});

const sessionId = await proc.sessionId();   // throws NoSessionError on crash
const result    = await proc.wait();        // { exitCode, sessionId, reason }
```

### Timeouts

Two thresholds, both per-spawn overridable:

- `outputTimeoutMs` (default 120000) — idle time between any stream-json
  events. Catches hung model calls and dead processes.
- `toolTimeoutMs`   (default 1800000) — idle time while a `tool_use` is
  unmatched by its `tool_result`. Allows long-running Bash/build tools.

On timeout the spawner emits `run.timeout`, sends SIGTERM, waits 5s, then
SIGKILL if needed.

### Tests

- Unit: `bun test test/cc-stream-parser.test.ts test/cc-watchdog.test.ts test/events.test.ts`
- Integration (fake claudev): `bun test test/cc-spawner.integration.test.ts`
  (uses `test/fixtures/fake-claudev`)
- Opt-in real-claudev smoke (costs a few cents):

  ```sh
  VOS_E2E_REAL=1 bun test test/cc-spawner.real.test.ts
  ```

  Not run in CI; trigger manually before /done on CC-spawner changes.
