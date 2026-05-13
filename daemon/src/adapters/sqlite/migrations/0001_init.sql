-- 0001_init: initial void-os v1 schema.
-- Per architecture spec (2026-05-13-void-os-v1-architecture.md):
--   events = "queryable activity log; powers cost meter and (later) activity feed".
-- Other tables are designed minimally to support spec'd contracts
-- (GET /chats, GET /agents, GET /folders, GET /cost/today, schedules).

-- Activity log. Spec pins this as Tier 1 monitoring surface.
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,           -- epoch ms
  type        TEXT    NOT NULL,           -- e.g. "run.start", "run.cost", "chat.msg"
  run_id      TEXT,                       -- nullable: not every event ties to a run
  chat_id     TEXT,                       -- nullable
  agent       TEXT,                       -- nullable
  data        TEXT NOT NULL DEFAULT '{}'  -- JSON payload
);
CREATE INDEX idx_events_ts   ON events(ts);
CREATE INDEX idx_events_type ON events(type, ts);
CREATE INDEX idx_events_run  ON events(run_id);
CREATE INDEX idx_events_chat ON events(chat_id, ts);

-- Chat sessions. Backs GET /chats → [{id, agent, title, last}].
CREATE TABLE chats (
  id         TEXT PRIMARY KEY,            -- uuid/nanoid, minted by daemon
  agent      TEXT NOT NULL,               -- agent name (vault/agents/<name>/)
  title      TEXT,                        -- nullable; auto/user assigned
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_msg   TEXT                         -- short preview, kept for list view
);
CREATE INDEX idx_chats_updated ON chats(updated_at DESC);

-- One CC spawn. Spec: "Has a run_id, a trace file, events in SQLite."
CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT,                       -- nullable: worker runs have none
  agent       TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- "chat" | "skill" | "worker"
  status      TEXT NOT NULL,              -- "running" | "done" | "error" | "cancelled"
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  trace_path  TEXT,                       -- .void/traces/<run_id>.jsonl
  error       TEXT,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL
);
CREATE INDEX idx_runs_chat    ON runs(chat_id, started_at DESC);
CREATE INDEX idx_runs_started ON runs(started_at DESC);

-- Per-turn cost ledger. Backs GET /cost/today → { total, by_agent }.
CREATE TABLE costs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,
  agent         TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  cost_usd      REAL NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  model         TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX idx_costs_ts    ON costs(ts);
CREATE INDEX idx_costs_agent ON costs(agent, ts);

-- Agent registry mirror. Spec: agent = folder at vault/agents/<name>/agent.md.
-- Vault is source of truth; this table is the synced index for fast lookup.
CREATE TABLE agents (
  name         TEXT PRIMARY KEY,
  description  TEXT,
  model        TEXT,
  vault_path   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Schedule mirror. Spec: ScheduleTrigger mirrors vault/schedules/*.md into SQLite.
-- Columns mirror the documented frontmatter shape.
CREATE TABLE schedules (
  name        TEXT PRIMARY KEY,            -- filename stem under vault/schedules/
  cron        TEXT NOT NULL,
  agent       TEXT,                        -- nullable: defaults to caller's
  skill       TEXT NOT NULL,
  inputs      TEXT NOT NULL DEFAULT '{}',  -- JSON
  enabled     INTEGER NOT NULL DEFAULT 1,
  max_cost    REAL,
  vault_path  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_schedules_enabled ON schedules(enabled);

-- Connected folders. Spec: "path outside the vault granted to one or more
-- agents via connected-folders.json". Mirror for plugin GET /folders.
CREATE TABLE connected_folders (
  path       TEXT PRIMARY KEY,
  label      TEXT,
  access     TEXT NOT NULL,                -- "ro" | "rw"
  agents     TEXT NOT NULL DEFAULT '[]',   -- JSON array of agent names
  updated_at INTEGER NOT NULL
);
