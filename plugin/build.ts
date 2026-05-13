import { mkdirSync, copyFileSync, watch as fsWatch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const watch = process.argv.includes("--watch");
const out = process.env.VOID_OS_PLUGIN_OUT
  ?? join(homedir(), "void", ".obsidian", "plugins", "void-os");

mkdirSync(out, { recursive: true });

async function buildOnce() {
  const result = await Bun.build({
    entrypoints: ["src/main.ts"],
    outdir: out,
    format: "cjs",
    target: "node",
    external: ["obsidian"],
    minify: !watch,
  });
  if (!result.success) {
    console.error(result.logs);
    if (!watch) process.exit(1);
    return;
  }
  copyFileSync("manifest.json", join(out, "manifest.json"));
  copyFileSync("styles.css",   join(out, "styles.css"));
  console.log(`[void-os/plugin] built → ${out}`);
}

await buildOnce();

if (watch) {
  const debounce = (fn: () => void, ms = 100) => {
    let h: any;
    return () => { clearTimeout(h); h = setTimeout(fn, ms); };
  };
  const rebuild = debounce(() => { buildOnce().catch(console.error); });
  fsWatch("src", { recursive: true }, rebuild);
  fsWatch("manifest.json", rebuild);
  fsWatch("styles.css",   rebuild);
  console.log("[void-os/plugin] watching src/...");
}
