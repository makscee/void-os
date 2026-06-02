// agents.ts — agent-as-file primitive (VOS-200). An Agent is a single file
// agents/<name>.md: frontmatter = STABLE identity (cacheable system-tier), body = VOLATILE memory.
// Pure + fs helpers only — no spawn (mirrors frontmatter.ts / chat.ts).
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentMeta {
  name: string;
  description: string;
  folders: string[];   // vault-relative dirs → enforced --add-dir scope
  mcps: string[];      // MCP server names → --mcp-config
  skills: string[];    // skill names the agent composes
  body: string;        // persistent memory (volatile)
}

export interface AgentLaunch {
  addDirs: string[];            // absolute dirs → extra --add-dir (enforced scope)
  mcpConfigPath: string | null; // absolute path to a written --mcp-config json, or null
  appendSystemPrompt: string;   // STABLE identity → --append-system-prompt (cacheable system tier)
  bodyMessage: string;          // VOLATILE memory → goes in the -p user message (messages tier)
  outputTarget: string;         // agents/<name>.md — the auto write-back target (191)
}

/** Parse a YAML-list-lite agent file. Supports `key:` followed by `  - item` lines. */
export function parseAgentFile(md: string): AgentMeta {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const out: AgentMeta = { name: "", description: "", folders: [], mcps: [], skills: [], body: "" };
  if (!m) { out.body = md; return out; }
  out.body = (m[2] ?? "").replace(/^\n+/, "");
  const lines = m[1].split("\n");
  let listKey: "folders" | "mcps" | "skills" | null = null;
  for (const line of lines) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { out[listKey].push(item[1].replace(/^["']|["']$/g, "").trim()); continue; }
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    const val = v.replace(/^["']|["']$/g, "").trim();
    listKey = null;
    if (k === "name") out.name = val;
    else if (k === "description") out.description = val;
    else if (k === "folders") { listKey = "folders"; if (val) out.folders.push(val); }
    else if (k === "mcps") { listKey = "mcps"; if (val) out.mcps.push(val); }
    else if (k === "skills") { listKey = "skills"; if (val) out.skills.push(val); }
  }
  return out;
}

export function agentPath(vault: string, name: string): string {
  return join(vault, "agents", `${name}.md`);
}

export function listAgents(vault: string): AgentMeta[] {
  const dir = join(vault, "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseAgentFile(readFileSync(join(dir, f), "utf8")))
    .filter((a) => a.name);
}

export function buildAgentLaunch(vault: string, name: string): AgentLaunch {
  const p = agentPath(vault, name);
  if (!existsSync(p)) throw new Error(`agent not found: ${name}`);
  const a = parseAgentFile(readFileSync(p, "utf8"));

  // STABLE identity — frontmatter-derived ONLY. Body MUST NOT appear here (cache split).
  // This string goes into --append-system-prompt (system tier, cacheable).
  // Editing the body does NOT change this string → cache hit across invocations.
  const appendSystemPrompt = [
    `You are the "${a.name}" agent. ${a.description}`,
    a.skills.length ? `You compose these skills (invoke by name): ${a.skills.join(", ")}.` : "",
    a.folders.length ? `Your access scope is limited to: ${a.folders.join(", ")}.` : "",
  ].filter(Boolean).join("\n");

  // VOLATILE memory — the body. Goes into the first user message (-p), after the cache breakpoint.
  const bodyMessage = a.body.trim();

  // mcps → a --mcp-config json restricting only those MCP servers (loaded once per launch).
  let mcpConfigPath: string | null = null;
  if (a.mcps.length) {
    const cfgDir = join(vault, ".void-os", "agent-mcp");
    mkdirSync(cfgDir, { recursive: true });
    mcpConfigPath = join(cfgDir, `${a.name}.json`);
    // Writes a minimal mcp config; server definitions are resolved from the vault's .mcp.json
    // at launch time when full MCP wiring is implemented (post-T1 scope).
    // Here the file is written so --mcp-config is a valid path; servers resolved later.
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
  }

  return {
    addDirs: a.folders.map((f) => join(vault, f)),
    mcpConfigPath,
    appendSystemPrompt,
    bodyMessage,
    outputTarget: `agents/${a.name}.md`,
  };
}
