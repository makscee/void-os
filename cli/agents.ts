import { parseArgs } from "./lib/args.ts";
import { buildClient, NoTokenError } from "./lib/client.ts";
import { UnreachableError } from "@voidos/protocol";
import { renderTable, formatJson } from "./lib/output.ts";

const USAGE = `usage: void-os agents <subcommand>

subcommands:
  list [--json]                    list agents from current vault
  prune-branches [--older-than <minutes>] [--json]
                                   remove the git worktrees the branch verb
                                   (POST /agents/:id/branch) accumulated
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
  if (sub === "prune-branches") return cmdPruneBranches(rest);
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

// VOS-165: GC the worktrees the branch verb leaves behind. `--older-than`
// (minutes) keeps worktrees touched more recently than the cutoff so a
// branch the operator is still in is not swept.
async function cmdPruneBranches(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"], values: ["older-than"] });
  if (parsed.help) { console.log(USAGE); return 0; }

  let olderThanMinutes: number | undefined;
  const raw = parsed.values["older-than"];
  if (raw !== undefined) {
    const m = Number(raw);
    if (!Number.isFinite(m) || m < 0) {
      console.error(`void-os agents prune-branches: --older-than must be a non-negative number of minutes`);
      return 2;
    }
    olderThanMinutes = m;
  }

  try {
    const client = buildClient();
    const r = await client.agents.pruneBranches(
      olderThanMinutes != null ? { olderThanMinutes } : undefined,
    );
    if (parsed.flags.json) {
      console.log(formatJson(r));
    } else {
      for (const w of r.pruned) console.log(`pruned  ${w.path}  (${w.branch})`);
      for (const w of r.kept) console.log(`kept    ${w.path}  (${w.branch}, touched recently)`);
      for (const w of r.failed) console.log(`failed  ${w.path}  (${w.branch}): ${w.error}`);
      console.log(
        `${r.pruned.length} pruned, ${r.kept.length} kept, ${r.failed.length} failed`,
      );
    }
    return r.failed.length > 0 ? 1 : 0;
  } catch (e) {
    if (e instanceof UnreachableError || e instanceof NoTokenError) {
      console.error(`daemon not running; try \`void-os daemon start\``);
      return 3;
    }
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
