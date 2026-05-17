import { cpSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./lib/args.ts";
import { buildClient, NoTokenError, UnreachableError } from "./lib/client.ts";
import { formatJson } from "./lib/output.ts";

const USAGE = `usage: void-os plugin <subcommand>

subcommands:
  install [--vault PATH] [--force]
  status  [--vault PATH] [--json]
`;

export default async function plugin(args: string[], ctx: { prefix: string }): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case "install": return cmdInstall(rest, ctx);
    case "status":  return cmdStatus(rest, ctx);
    default:
      console.error(`void-os plugin: unknown subcommand "${sub}"`);
      console.error(USAGE);
      return 2;
  }
}

async function resolveVault(args: { vault?: string }): Promise<string | { code: number }> {
  if (args.vault) return args.vault;
  try {
    const client = buildClient();
    const h = await client.health();
    return h.vault_root;
  } catch (e) {
    if (e instanceof UnreachableError || e instanceof NoTokenError) {
      console.error(`no --vault and daemon not running; try \`void-os daemon start\` or pass --vault PATH`);
      return { code: 3 };
    }
    console.error(e instanceof Error ? e.message : String(e));
    return { code: 1 };
  }
}

async function cmdInstall(args: string[], ctx: { prefix: string }): Promise<number> {
  const parsed = parseArgs(args, { flags: ["force"], values: ["vault"] });
  if (parsed.help) { console.log(USAGE); return 0; }
  const resolved = await resolveVault({ vault: parsed.values.vault });
  if (typeof resolved !== "string") return resolved.code;
  const vault = resolved;

  const src = join(ctx.prefix, "plugin/dist");
  if (!existsSync(src)) {
    console.error("plugin not built; run `bun run build` in plugin/");
    return 1;
  }
  const target = join(vault, ".obsidian/plugins/void-os");
  const srcManifest = readManifest(join(src, "manifest.json"));
  const tgtManifest = existsSync(join(target, "manifest.json")) ? readManifest(join(target, "manifest.json")) : null;

  if (!parsed.flags.force && tgtManifest && tgtManifest.version === srcManifest?.version) {
    console.log(`up-to-date (version ${srcManifest.version})`);
    return 0;
  }

  mkdirSync(target, { recursive: true });
  cpSync(src, target, { recursive: true, force: true });
  console.log(`installed plugin to ${target} (version ${srcManifest?.version ?? "?"})`);
  return 0;
}

async function cmdStatus(args: string[], ctx: { prefix: string }): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"], values: ["vault"] });
  if (parsed.help) { console.log(USAGE); return 0; }
  const resolved = await resolveVault({ vault: parsed.values.vault });
  if (typeof resolved !== "string") return resolved.code;
  const vault = resolved;

  const src = join(ctx.prefix, "plugin/dist");
  const target = join(vault, ".obsidian/plugins/void-os");
  const sm = existsSync(join(src, "manifest.json")) ? readManifest(join(src, "manifest.json")) : null;
  const tm = existsSync(join(target, "manifest.json")) ? readManifest(join(target, "manifest.json")) : null;

  let status: "missing" | "up-to-date" | "upgrade-available" | "ahead";
  if (!tm) status = "missing";
  else if (!sm || sm.version === tm.version) status = "up-to-date";
  else if ((tm.version ?? "") < (sm.version ?? "")) status = "upgrade-available";
  else status = "ahead";

  if (parsed.flags.json) {
    console.log(formatJson({ installed: tm?.version ?? null, source: sm?.version ?? null, target_path: target, status }));
  } else {
    console.log(`installed: ${tm?.version ?? "(none)"}  source: ${sm?.version ?? "(none)"}  status: ${status}`);
  }
  return 0;
}

function readManifest(path: string): { version?: string; id?: string } | null {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
