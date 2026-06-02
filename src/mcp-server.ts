// mcp-server.ts — VOS-199 Phase 2. A stdio MCP server that exposes skill_manage tools.
// Transport: stdio MCP server that calls the running daemon's HTTP API for mutation context
// (vault path, db access) OR is started with VOID_OS_VAULT set to work directly.
//
// Architecture choice (ADR note): stdio server calls daemon's /skill-manage/* endpoints
// rather than importing skill-manage.ts directly. This keeps the daemon the single owner
// of mutation state. For simplicity in this PoC, the server can also run in "direct" mode
// (VOID_OS_MCP_DIRECT=1) where it imports skill-manage directly — used by the proof script.
//
// Thin-wrapper rule: MCP tools call the Phase-1 skill-manage engine; zero mutation logic here.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { vaultRoot } from "./paths.ts";

// ---------------------------------------------------------------------------
// Daemon HTTP calls (non-direct mode)
// ---------------------------------------------------------------------------

async function daemonPost(daemonUrl: string, path: string, body: unknown): Promise<unknown> {
  const r = await fetch(`${daemonUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`daemon ${path} → ${r.status}: ${text}`);
  }
  return r.json();
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "skill_manage",
    description:
      "Create, patch, edit, delete, or write_file in a vault skill. " +
      "Every mutation is routed through the VOS-194 decision pipeline — " +
      "a Decision is parked and the change only goes live after operator approval. " +
      "Returns { txnId, decisionId, status: 'parked' }.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "patch", "edit", "delete", "write_file"],
          description: "Mutation type. patch=old→new tweak; edit=full rewrite; create=new skill; delete=remove; write_file=add asset file.",
        },
        name: {
          type: "string",
          description: "Skill name (slug, e.g. 'my-skill').",
        },
        body: {
          type: "string",
          description: "Full SKILL.md content (required for create/edit). For patch, the desired new body.",
        },
        old_body: {
          type: "string",
          description: "Prior SKILL.md content (required for patch, for diff context).",
        },
        trigger: {
          type: "string",
          description: "Optional trigger file body (YAML frontmatter). If provided, the skill will be bus-bound and routed live after approval.",
        },
        file_path: {
          type: "string",
          description: "Vault-relative sub-path for write_file action (e.g. 'examples/example.md').",
        },
        content: {
          type: "string",
          description: "File content for write_file action.",
        },
        exec_id: {
          type: "string",
          description: "The CC execution ID calling this tool (used for resumption-intent).",
        },
      },
      required: ["action", "name"],
    },
  },
  {
    name: "skills_list",
    description: "List all skills currently installed in the vault. Returns an array of { name, description, version }.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "skill_view",
    description: "Return the raw SKILL.md body for one vault skill (progressive disclosure).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name to view.",
        },
      },
      required: ["name"],
    },
  },
];

// ---------------------------------------------------------------------------
// Main server factory
// ---------------------------------------------------------------------------

export function createMcpServer(opts: { daemonUrl?: string; vault?: string; directMode?: boolean }) {
  const server = new Server(
    { name: "void-os-skill-manage", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const vault = opts.vault ?? vaultRoot();

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    if (name === "skills_list") {
      return await handleSkillsList(vault, opts);
    }

    if (name === "skill_view") {
      return await handleSkillView(vault, String(a.name ?? ""), opts);
    }

    if (name === "skill_manage") {
      return await handleSkillManage(vault, a, opts);
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    } as CallToolResult;
  });

  return server;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleSkillsList(
  vault: string,
  opts: { daemonUrl?: string; directMode?: boolean },
): Promise<CallToolResult> {
  if (opts.directMode || !opts.daemonUrl) {
    const { listVaultSkills } = await import("./skill-manage.ts");
    const skills = listVaultSkills(vault);
    return {
      content: [{ type: "text", text: JSON.stringify(skills, null, 2) }],
    };
  }
  const result = await daemonPost(opts.daemonUrl, "/skill-manage/skills_list", {});
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function handleSkillView(
  vault: string,
  skillName: string,
  opts: { daemonUrl?: string; directMode?: boolean },
): Promise<CallToolResult> {
  if (!skillName) {
    return { isError: true, content: [{ type: "text", text: "name is required" }] };
  }
  if (opts.directMode || !opts.daemonUrl) {
    const { viewVaultSkill } = await import("./skill-manage.ts");
    const body = viewVaultSkill(vault, skillName);
    if (!body) {
      return { isError: true, content: [{ type: "text", text: `Skill not found: ${skillName}` }] };
    }
    return { content: [{ type: "text", text: body }] };
  }
  const result = await daemonPost(opts.daemonUrl, "/skill-manage/skill_view", { name: skillName });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

async function handleSkillManage(
  vault: string,
  a: Record<string, unknown>,
  opts: { daemonUrl?: string; directMode?: boolean },
): Promise<CallToolResult> {
  const action = String(a.action ?? "");
  const skillName = String(a.name ?? "");
  const execId = String(a.exec_id ?? `mcp-${randomUUID()}`);

  if (!action || !skillName) {
    return { isError: true, content: [{ type: "text", text: "action and name are required" }] };
  }

  if (opts.directMode || !opts.daemonUrl) {
    return await handleSkillManageDirect(vault, action, skillName, execId, a);
  }

  // Daemon mode: POST to /skill-manage/mutate
  const result = await daemonPost(opts.daemonUrl, "/skill-manage/mutate", {
    action, name: skillName, exec_id: execId,
    body: a.body, old_body: a.old_body, trigger: a.trigger,
    file_path: a.file_path, content: a.content,
  });
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function handleSkillManageDirect(
  vault: string,
  action: string,
  skillName: string,
  execId: string,
  a: Record<string, unknown>,
): Promise<CallToolResult> {
  const {
    gateCreate, gatePatch, gateEdit, gateDelete, gateWriteFile,
  } = await import("./skill-manage.ts");

  let result: { txnId: string; decisionId: string; status: string };

  if (action === "create") {
    const body = String(a.body ?? "");
    if (!body) return { isError: true, content: [{ type: "text", text: "body required for create" }] };
    result = gateCreate(vault, {
      execId, name: skillName, body,
      trigger: a.trigger ? String(a.trigger) : undefined,
    });
  } else if (action === "patch") {
    const oldBody = String(a.old_body ?? "");
    const newBody = String(a.body ?? "");
    if (!oldBody || !newBody) return { isError: true, content: [{ type: "text", text: "old_body and body required for patch" }] };
    result = gatePatch(vault, {
      execId, name: skillName, oldBody, newBody,
      trigger: a.trigger ? String(a.trigger) : undefined,
    });
  } else if (action === "edit") {
    const body = String(a.body ?? "");
    if (!body) return { isError: true, content: [{ type: "text", text: "body required for edit" }] };
    result = gateEdit(vault, {
      execId, name: skillName, body,
      trigger: a.trigger ? String(a.trigger) : undefined,
    });
  } else if (action === "delete") {
    result = gateDelete(vault, { execId, name: skillName });
  } else if (action === "write_file") {
    const filePath = String(a.file_path ?? "");
    const content = String(a.content ?? "");
    if (!filePath || !content) return { isError: true, content: [{ type: "text", text: "file_path and content required for write_file" }] };
    result = gateWriteFile(vault, { execId, name: skillName, filePath, content });
  } else {
    return { isError: true, content: [{ type: "text", text: `Unknown action: ${action}` }] };
  }

  const text = `Decision parked — awaiting operator approval.\ntxnId: ${result.txnId}\ndecisionId: ${result.decisionId}\nstatus: ${result.status}\n\nTo approve: append a kind=decision-reply bus line with routing.decisionRef=${result.decisionId}`;
  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const daemonUrl = process.env.VOID_OS_DAEMON_URL;
  const vault = process.env.VOID_OS_VAULT ?? vaultRoot();
  const directMode = process.env.VOID_OS_MCP_DIRECT === "1" || !daemonUrl;

  const server = createMcpServer({ daemonUrl, vault, directMode });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdin closes
}
