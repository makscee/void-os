// VOS-106 T0: verify CC's PreToolUse hook-error fail-mode.
//
// Spawns `claudev claude -p '<prompt>' --settings <broken-hook.json>` and
// asks CC to call Edit on a path. The hook script is deliberately broken
// (exits 1 with no stdout). We assert CC denies the tool call.
//
// Run: bun run daemon/test/spikes/vos-106-hook-fail-mode.ts
// Exit 0 = fail-closed (good). Exit 1 = fail-open (BAD — design must change).

import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "vos-106-spike-"));
const brokenHook = join(dir, "broken.sh");
const settingsPath = join(dir, "settings.json");

writeFileSync(brokenHook, "#!/bin/sh\nexit 1\n");
chmodSync(brokenHook, 0o755);

writeFileSync(
  settingsPath,
  JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|MultiEdit",
          hooks: [{ type: "command", command: brokenHook }],
        },
      ],
    },
  }),
);

const probeFile = join(dir, "probe.txt");
writeFileSync(probeFile, "before\n");

const prompt =
  `Use the Edit tool to change the word "before" to "after" in the file ${probeFile}. ` +
  `Then say "DONE" or "BLOCKED" depending on whether the edit succeeded.`;

const proc = Bun.spawn(
  [
    "claudev",
    "claude",
    "-p",
    prompt,
    "--settings",
    settingsPath,
    "--output-format",
    "stream-json",
    "--verbose",
  ],
  { stdout: "pipe", stderr: "pipe" },
);

const out = await new Response(proc.stdout).text();
const err = await new Response(proc.stderr).text();
await proc.exited;

const finalContent = await Bun.file(probeFile).text();

console.log("--- stdout (last 40 lines) ---");
console.log(out.split("\n").slice(-40).join("\n"));
console.log("--- stderr (last 20 lines) ---");
console.log(err.split("\n").slice(-20).join("\n"));
console.log("--- probe file final content ---");
console.log(JSON.stringify(finalContent));

if (finalContent === "before\n") {
  console.log("VERDICT: fail-closed (Edit denied, file unchanged). GOOD.");
  process.exit(0);
}
console.log("VERDICT: fail-open (Edit ran despite broken hook). BAD — design must change.");
process.exit(1);
