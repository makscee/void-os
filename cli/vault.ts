import { readFileSync } from "node:fs";
import { parseArgs } from "./lib/args.ts";
import { buildClient, NoTokenError } from "./lib/client.ts";
import { ApiError, UnreachableError } from "@voidos/protocol";
import { formatJson } from "./lib/output.ts";

const USAGE = `usage: void-os vault <subcommand>

subcommands:
  read <path> [--json]
  write <path> {--content STR | --from-file LOCAL | --stdin}
  list [<path>] [--depth N] [--json]
`;

export default async function vault(args: string[]): Promise<number> {
  // Dispatcher passes argv.slice(1) to handler (e.g. ["read", "notes.md"] for `void-os vault read notes.md`).
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case "read":  return cmdRead(rest);
    case "write": return cmdWrite(rest);
    case "list":  return cmdList(rest);
    default:
      console.error(`void-os vault: unknown subcommand "${sub}"`);
      console.error(USAGE);
      return 2;
  }
}

async function cmdRead(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"], values: [] });
  if (parsed.help) { console.log(USAGE); return 0; }
  const path = parsed.positional[0];
  if (!path) { console.error("usage: void-os vault read <path>"); return 2; }
  try {
    const client = buildClient();
    const r = await client.vault.read(path);
    if (parsed.flags.json) console.log(formatJson(r));
    else process.stdout.write(r.content);   // byte-exact, no added newline
    return 0;
  } catch (e) {
    return handleError(e);
  }
}

async function cmdWrite(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["stdin", "json"], values: ["content", "from-file"] });
  if (parsed.help) { console.log(USAGE); return 0; }
  const path = parsed.positional[0];
  if (!path) { console.error("usage: void-os vault write <path> {--content STR | --from-file LOCAL | --stdin}"); return 2; }

  const sources: Array<{ kind: string; value: string | true }> = [];
  if (parsed.values["content"] !== undefined) sources.push({ kind: "content", value: parsed.values["content"] });
  if (parsed.values["from-file"] !== undefined) sources.push({ kind: "from-file", value: parsed.values["from-file"] });
  if (parsed.flags.stdin) sources.push({ kind: "stdin", value: true });
  if (sources.length !== 1) {
    console.error("usage: vault write requires exactly one source: --content, --from-file, or --stdin");
    return 2;
  }

  let body: string;
  const src = sources[0];
  if (src.kind === "content") body = src.value as string;
  else if (src.kind === "from-file") body = readFileSync(src.value as string, "utf8");
  else body = await readStdin();

  try {
    const client = buildClient();
    const r = await client.vault.write(path, body);
    if (parsed.flags.json) console.log(formatJson(r));
    else console.log(`wrote ${path} (${r.size} bytes)`);
    return 0;
  } catch (e) {
    return handleError(e);
  }
}

async function cmdList(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"], values: ["depth"] });
  if (parsed.help) { console.log(USAGE); return 0; }
  const subpath = parsed.positional[0];
  const depth = parsed.values.depth != null ? parseInt(parsed.values.depth, 10) : undefined;
  try {
    const client = buildClient();
    const r = await client.vault.list(subpath, depth != null ? { depth } : undefined);
    if (parsed.flags.json) console.log(formatJson(r));
    else for (const e of r.entries) console.log(e.type === "dir" ? `${e.name}/` : e.name);
    return 0;
  } catch (e) {
    return handleError(e);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function handleError(e: unknown): number {
  if (e instanceof UnreachableError || e instanceof NoTokenError) {
    console.error(`daemon not running; try \`void-os daemon start\``);
    return 3;
  }
  if (e instanceof ApiError) {
    if (e.code === "E_BINARY") { console.error("binary file, use --json"); return 1; }
    console.error(`${e.code}: ${e.message}`);
    return 1;
  }
  console.error(e instanceof Error ? e.message : String(e));
  return 1;
}
