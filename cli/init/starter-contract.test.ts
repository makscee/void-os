import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Contract tests for `starter-vault/`. These pin invariants that can ONLY
 * be enforced at the file level (prompt-level "do not call X" instructions
 * are unreliable for LLMs).
 *
 * F7 regression: tinker's frontmatter listed `ask_agent` in `tools:`, so
 * even after we added prose telling it not to dispatch, the model still
 * called `ask_agent("maya", ...)` on a fresh vault. The fix is to remove
 * the capability entirely from the seeded agent; this test pins that.
 */

const STARTER_DIR = resolve(import.meta.dir, "../../starter-vault")

function parseFrontmatter(md: string): Record<string, unknown> {
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  if (!m) throw new Error("no frontmatter")
  // Cheap YAML-list parse — sufficient for the keys we assert on.
  const out: Record<string, unknown> = {}
  let currentKey: string | null = null
  let currentList: string[] | null = null
  for (const rawLine of m[1].split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (!line.trim()) continue
    if (line.startsWith("  - ")) {
      if (currentList) currentList.push(line.slice(4).trim())
      continue
    }
    if (line.startsWith("  ")) continue // nested map — skip
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/)
    if (!kv) continue
    const [, k, v] = kv
    if (currentKey && currentList) out[currentKey] = currentList
    currentKey = k
    currentList = null
    if (v === "" || v === undefined) {
      currentList = []
    } else {
      out[k] = v.trim()
    }
  }
  if (currentKey && currentList) out[currentKey] = currentList
  return out
}

describe("starter-vault tinker agent.md", () => {
  const path = resolve(STARTER_DIR, "agents/tinker/agent.md")
  const md = readFileSync(path, "utf8")
  const fm = parseFrontmatter(md)

  it("frontmatter tools list excludes ask_agent (F7 contract)", () => {
    const tools = fm.tools as string[]
    expect(Array.isArray(tools)).toBe(true)
    expect(tools).not.toContain("ask_agent")
  })

  it("frontmatter tools list still includes core vault + ask_user tools", () => {
    const tools = fm.tools as string[]
    // The starter agent must still be able to read/write the vault and ask
    // the user — those are the irreducible Concierge capabilities.
    for (const t of ["vault.read", "vault.write", "ask_user"]) {
      expect(tools).toContain(t)
    }
  })

  it("prose does not instruct using ask_agent at seed (F7 belt-and-braces)", () => {
    // The body may mention ask_agent in the context of explaining the future,
    // but it must NOT contain an instruction phrased as a call site, e.g.
    // 'ask_agent("<name>", ...)' as a recommended hand-off action. We pin
    // the absence of the specific Hand-offs imperative that triggered the
    // hallucination in smoke testing.
    expect(md).not.toMatch(/Hand-offs:[^\n]*`ask_agent\("/)
  })
})
