// VOS-106 T7: daemon boot-time deny-probe. Sends a known out-of-scope
// Edit payload to the PreToolUse hook script with a deliberately
// restrictive scope env. Expects the hook to DENY — i.e. either the
// modern shape {continue: true, decision: "block", reason: ...} or the
// legacy hard-stop {continue: false}. If the hook returns a plain
// {continue: true} (no block decision), scope enforcement is fail-open
// and the daemon refuses to start.

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

  let parsed: { continue?: boolean; decision?: "block" };
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    return { ok: false, reason: `hook produced non-JSON stdout: ${out.slice(0, 200)}` };
  }
  const denied = parsed.continue === false || parsed.decision === "block";
  if (!denied) {
    return {
      ok: false,
      reason: "boot deny-probe failed: hook returned plain continue=true for out-of-scope Edit (fail-open). Refusing to start daemon.",
    };
  }
  return { ok: true };
}
