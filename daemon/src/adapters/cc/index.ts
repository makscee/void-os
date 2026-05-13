// CC spawner. Invokes `claudev claude ...` subprocess.
// T4: version-probe helper. Full spawner is VOS-73 downstream.

export interface CcSpawnRequest {
  prompt: string;
  agent: string;
  cwd: string;
  settings?: unknown;
}

export interface CcProcess {
  pid: number;
  runId: string;
  kill(): Promise<void>;
  wait(): Promise<{ exitCode: number }>;
}

export interface CcSpawner {
  spawn(req: CcSpawnRequest): Promise<CcProcess>;
}

export interface ProbeResult {
  ok: boolean;
  version?: string;
  output?: string;
  error?: string;
  code: number;
}

const VERSION_RE = /(\d+\.\d+(?:\.\d+)?)\s*\(Claude Code\)/;
const FALLBACK_VERSION_RE = /\b(\d+\.\d+\.\d+)\b/;

/**
 * Probe claudev by invoking `claudev claude --version`.
 * Returns structured result. Handles ENOENT (claudev not on PATH) gracefully.
 */
export const probeClaudev = async (
  binary = "claudev",
): Promise<ProbeResult> => {
  let proc: Awaited<ReturnType<typeof Bun.spawn>>;
  try {
    proc = Bun.spawn({
      cmd: [binary, "claude", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return {
      ok: false,
      error: e.code === "ENOENT" ? "claudev not found on PATH" : (e.message ?? String(err)),
      code: -1,
    };
  }

  const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
  const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(stdoutStream).text(),
    new Response(stderrStream).text(),
    proc.exited,
  ]);

  const output = (stdout + stderr).trim();

  if (exitCode !== 0) {
    return {
      ok: false,
      output,
      error: `claudev exited with code ${exitCode}`,
      code: exitCode,
    };
  }

  const match = output.match(VERSION_RE) ?? output.match(FALLBACK_VERSION_RE);
  if (!match) {
    return {
      ok: false,
      output,
      error: "could not parse version from claudev output",
      code: exitCode,
    };
  }

  return {
    ok: true,
    version: match[1],
    output,
    code: exitCode,
  };
};

export const createCcSpawner = (): CcSpawner => {
  throw new Error("not implemented");
};
