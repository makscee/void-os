// VOS-107 T12: starter-agents surface S6.
//
// Plan asked for assertions on read_scopes / write_scopes / mcp_allowlist over
// the GET /agents wire shape. Reality (verified 2026-05-17):
//   * GET /agents returns { agents: AgentListEntry[] } where
//     AgentListEntry = { name: string; description: string } only.
//     Source of truth: daemon/src/api/agents.ts + daemon/src/agents/types.ts.
//     There is no read_scopes / write_scopes / mcp_allowlist on the wire.
//   * The scope data lives in starter-vault frontmatter as singular
//     `read_scope` / `write_scope` arrays (see starter-vault/agents/*/agent.md).
//   * `mcp_allowlist` does not exist anywhere; the closest concept is the
//     frontmatter `tools: []` array.
//   * The shared e2e daemon runs against plugin/e2e/fixtures/daemon-vault
//     whose stub agent.md files (maya, journaler) only declare
//     name/description/model — no scope frontmatter at all. So the wire
//     can't surface scopes for the fixture run.
//
// To preserve the spirit of the plan ("starter agents register with scoped
// read/write + allowlist invariants") this spec asserts:
//   * Wire: GET /agents has ≥2 entries with name + description strings.
//   * Filesystem (the canonical starter-vault, NOT the e2e fixture):
//     for each starter agent (maya, journaler, task-tracker),
//     - frontmatter `read_scope` is a non-empty array
//     - frontmatter `write_scope` is an array (may be empty for maya)
//     - every write_scope is covered by some read_scope
//       (equal or prefix-of), enforcing write ⊆ read.
//
// Reads frontmatter directly via gray-matter (same parser the daemon's
// scanVaultAgents uses). The starter-vault path is resolved relative to
// the spec file so it works from any cwd.

import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface E2EState {
  port: number;
}

// Minimal frontmatter parser — extracts the `---\n...\n---` block and
// reads the fields we need (name, read_scope, write_scope). Avoids a
// gray-matter dep (not installed in plugin/). Only supports the shapes
// the starter-vault uses: scalar string and inline-array `['a', 'b']`.
function parseStarterFrontmatter(raw: string): {
  name: string | null;
  read_scope: string[] | null;
  write_scope: string[] | null;
} {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { name: null, read_scope: null, write_scope: null };
  const block = m[1];
  const out: { name: string | null; read_scope: string[] | null; write_scope: string[] | null } = {
    name: null, read_scope: null, write_scope: null,
  };
  for (const line of block.split("\n")) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    if (key === "name") {
      out.name = rawVal.replace(/^['"]|['"]$/g, "");
    } else if (key === "read_scope" || key === "write_scope") {
      // Expect inline array like ['vault/**'] or [] — possibly with double quotes.
      const arr = rawVal.match(/^\[(.*)\]$/);
      if (!arr) continue;
      const inner = arr[1].trim();
      if (inner.length === 0) {
        out[key] = [];
      } else {
        out[key] = inner.split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
      }
    }
  }
  return out;
}

function readE2EState(): E2EState {
  const statePath = process.env.VOS_E2E_STATE;
  if (!statePath) throw new Error("VOS_E2E_STATE not set — globalSetup did not run");
  return JSON.parse(readFileSync(statePath, "utf8")) as E2EState;
}

// starter-vault lives at <repo-root>/starter-vault; spec is at
// <repo-root>/plugin/e2e/specs/starter-agents.spec.ts. Use import.meta.url
// because the spec runs in an ESM scope (__dirname is undefined).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STARTER_AGENTS_DIR = resolve(__dirname, "..", "..", "..", "starter-vault", "agents");

test("GET /agents returns ≥2 entries with name + description", async ({ request }) => {
  const state = readE2EState();
  const res = await request.get(`http://127.0.0.1:${state.port}/agents`);
  expect(res.ok()).toBe(true);
  const body = await res.json();

  expect(Array.isArray(body.agents)).toBe(true);
  expect(body.agents.length).toBeGreaterThanOrEqual(2);

  for (const a of body.agents) {
    expect(typeof a.name, `name on ${JSON.stringify(a)}`).toBe("string");
    expect(a.name.length).toBeGreaterThan(0);
    expect(typeof a.description, `description on ${a.name}`).toBe("string");
    expect(a.description.length).toBeGreaterThan(0);
  }
});

test("starter-vault agents declare scoped read/write with write ⊆ read", () => {
  const folders = readdirSync(STARTER_AGENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  // Plan stated 3 starter agents (maya, journaler, task-tracker).
  expect(folders.length).toBeGreaterThanOrEqual(3);
  for (const required of ["maya", "journaler", "task-tracker"]) {
    expect(folders, `missing starter agent: ${required}`).toContain(required);
  }

  for (const folder of folders) {
    const filePath = join(STARTER_AGENTS_DIR, folder, "agent.md");
    const raw = readFileSync(filePath, "utf8");
    const fm = parseStarterFrontmatter(raw);

    expect(fm.name, `${folder}: frontmatter name missing or mismatch`).toBe(folder);

    const reads = fm.read_scope;
    expect(reads !== null, `${folder}: read_scope key missing`).toBe(true);
    expect(Array.isArray(reads), `${folder}: read_scope must be array`).toBe(true);
    expect((reads as string[]).length, `${folder}: read_scope must be non-empty`).toBeGreaterThan(0);

    const writes = fm.write_scope;
    expect(writes !== null, `${folder}: write_scope key missing`).toBe(true);
    expect(Array.isArray(writes), `${folder}: write_scope must be array`).toBe(true);

    // Invariant: every write scope must be covered by some read scope
    // (equal or prefix match — write ⊆ read).
    for (const w of writes as string[]) {
      const covered = (reads as string[]).some((r) => w === r || w.startsWith(r) || prefixMatches(r, w));
      expect(covered, `${folder}: write scope "${w}" not covered by any read_scope ${JSON.stringify(reads)}`).toBe(true);
    }
  }
});

// A glob-aware prefix check: `vault/**` should cover `vault/work/**`.
// Strip a trailing `/**` (or `**`) from the read pattern before testing prefix.
function prefixMatches(readPattern: string, writePattern: string): boolean {
  const stripped = readPattern.replace(/\/\*\*$/, "/").replace(/\*\*$/, "");
  return stripped.length > 0 && writePattern.startsWith(stripped);
}
