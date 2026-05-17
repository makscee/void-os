import { parseArgs } from "./lib/args.ts";
import { buildClient, NoTokenError } from "./lib/client.ts";
import { UnreachableError } from "@voidos/protocol";
import { renderTable, formatJson } from "./lib/output.ts";

const USAGE = `usage: void-os agents <subcommand>

subcommands:
  list [--json]   list agents from current vault
`;

export default async function agents(args: string[]): Promise<number> {
  // Dispatcher passes argv.slice(1) to handler (e.g. ["start", "--port", "8080"] for `void-os daemon start --port 8080`).
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return sub ? 0 : 2;
  }
  if (sub === "list") return cmdList(rest);
  console.error(`void-os agents: unknown subcommand "${sub}"`);
  console.error(USAGE);
  return 2;
}

async function cmdList(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"], values: [] });
  if (parsed.help) { console.log(USAGE); return 0; }
  try {
    const client = buildClient();
    const r = await client.agents.list();
    if (parsed.flags.json) console.log(formatJson(r));
    else {
      if (r.agents.length === 0) console.log("(no agents)");
      else console.log(renderTable(r.agents, [{ key: "name", width: 20 }, { key: "description", width: 58 }]));
    }
    return 0;
  } catch (e) {
    if (e instanceof UnreachableError || e instanceof NoTokenError) {
      console.error(`daemon not running; try \`void-os daemon start\``);
      return 3;
    }
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
