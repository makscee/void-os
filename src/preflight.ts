// preflight.ts — prerequisite checks (Task 7)
// F6: vc logged-in detection via ~/.claudev/token presence + injected vcStatus probe.
// Never hangs on a login prompt — deps are injected for testability.

export interface PreflightDeps {
  /** Return true if binary is on PATH */
  which: (bin: string) => Promise<boolean>;
  /** Return { ok: true } when vc is logged in (token present + valid) */
  vcStatus: () => Promise<{ ok: boolean; text: string }>;
}

export interface PreflightResult {
  ok: boolean;
  needsLogin: boolean;
  problems: string[];
}

export async function checkPrereqs(deps: PreflightDeps): Promise<PreflightResult> {
  const problems: string[] = [];
  let needsLogin = false;

  const [hasVc, hasClaude] = await Promise.all([
    deps.which("vc"),
    deps.which("claude"),
  ]);

  if (!hasVc) problems.push("vc not found — install via: curl -fsSL https://auth.makscee.ru/cv/install.sh | sh");
  if (!hasClaude) problems.push("claude not found — install Claude Code CLI");

  // Only probe vcStatus if vc is present; otherwise we'd get a crash
  if (hasVc) {
    const status = await deps.vcStatus();
    if (!status.ok) {
      needsLogin = true;
      problems.push("vc not logged in — run: vc login");
    }
  }

  return { ok: problems.length === 0, needsLogin, problems };
}

/**
 * Production implementation of PreflightDeps.
 * Uses ~/.claudev/token presence as the fast path, then calls `vc status --json`
 * as a non-interactive probe (exits immediately, never hangs on a prompt).
 */
export function productionDeps(): PreflightDeps {
  return {
    which: async (bin) => {
      const proc = Bun.spawn(["which", bin], { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      return code === 0;
    },
    vcStatus: async () => {
      // Fast path: token file presence
      const tokenPath = `${process.env.HOME}/.claudev/token`;
      if (!require("node:fs").existsSync(tokenPath)) {
        return { ok: false, text: "token file absent" };
      }
      // Cheap non-interactive probe: `vc status` should exit 0 when logged in
      try {
        const proc = Bun.spawn(["vc", "status"], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        });
        // Enforce a short timeout — never block
        const timeoutId = setTimeout(() => proc.kill(), 5000);
        const code = await proc.exited;
        clearTimeout(timeoutId);
        const text = await new Response(proc.stdout).text();
        return { ok: code === 0, text };
      } catch {
        return { ok: false, text: "probe failed" };
      }
    },
  };
}

// Legacy export for any callers that used the old stub name
export const checkPreflight = () => checkPrereqs(productionDeps());

// Singleton real deps used by server.ts (avoids re-constructing on each request)
export const realDeps: PreflightDeps = productionDeps();
