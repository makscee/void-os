// VOS-106 T7: daemon boot-time deny-probe. Sends a known out-of-scope
// Edit payload to the PreToolUse hook script with a deliberately
// restrictive scope env. Expects continue=false. If the hook returns
// continue=true, the entire scope-enforcement design is broken —
// daemon refuses to start.

export interface BootProbeArgs {
  hookScriptPath: string;
  /** Test seam: override Bun.spawn. */
  spawnFn?: (cmd: string[], opts: Parameters<typeof Bun.spawn>[1]) => ReturnType<typeof Bun.spawn>;
}

export interface BootProbeResult {
  ok: boolean;
  reason?: string;
}

export async function runBootDenyProbe(args: BootProbeArgs): Promise<BootProbeResult> {
  const spawnFn = args.spawnFn ?? Bun.spawn;
  const proc = spawnFn(["bun", args.hookScriptPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      VOS_READ_PATHS: JSON.stringify(["/nonexistent/**"]),
      VOS_WRITE_PATHS: JSON.stringify(["/nonexistent/**"]),
      VOS_SYSTEM_DENY: JSON.stringify([]),
      VOS_VAULT_ROOT: "/nonexistent",
    },
  });

  const payload = JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: "/etc/passwd" },
  });
  (proc.stdin as { write: (s: string) => void; end: () => void }).write(payload);
  (proc.stdin as { end: () => void }).end();

  const out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  await proc.exited;

  let parsed: { continue?: boolean };
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    return { ok: false, reason: `hook produced non-JSON stdout: ${out.slice(0, 200)}` };
  }
  if (parsed.continue === true) {
    return {
      ok: false,
      reason: "boot deny-probe failed: hook returned continue=true for out-of-scope Edit (fail-open). Refusing to start daemon.",
    };
  }
  return { ok: true };
}
