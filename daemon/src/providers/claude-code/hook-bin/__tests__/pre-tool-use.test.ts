import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", "pre-tool-use.ts");
const VAULT = "/tmp/vos-106-hook-test-vault"; // doesn't need to exist for matchPath

async function runHook(input: unknown, env: Record<string, string>): Promise<{
  stdout: string;
  exitCode: number;
  decision: { continue: boolean; stopReason?: string };
}> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env, VOS_VAULT_ROOT: VAULT },
  });
  proc.stdin.write(JSON.stringify(input));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  const decision = JSON.parse(stdout.trim());
  return { stdout, exitCode, decision };
}

const readJournalOnly = {
  VOS_READ_PATHS: JSON.stringify([`${VAULT}/journal/**`]),
  VOS_WRITE_PATHS: JSON.stringify([`${VAULT}/journal/**`]),
  VOS_SYSTEM_DENY: JSON.stringify([`${VAULT}/agents/**`]),
};

describe("pre-tool-use hook", () => {
  it("allows Read inside read_scope", async () => {
    const { decision, exitCode } = await runHook(
      { tool_name: "Read", tool_input: { file_path: `${VAULT}/journal/2026-05-16.md` } },
      readJournalOnly,
    );
    expect(exitCode).toBe(0);
    expect(decision.continue).toBe(true);
  });

  it("denies Read outside read_scope", async () => {
    const { decision } = await runHook(
      { tool_name: "Read", tool_input: { file_path: `${VAULT}/work/tasks/active/X.md` } },
      readJournalOnly,
    );
    expect(decision.continue).toBe(false);
    expect(decision.stopReason).toMatch(/READ_SCOPE_DENIED/);
  });

  it("allows Edit inside write_scope", async () => {
    const { decision } = await runHook(
      { tool_name: "Edit", tool_input: { file_path: `${VAULT}/journal/2026-05-16.md` } },
      readJournalOnly,
    );
    expect(decision.continue).toBe(true);
  });

  it("denies Edit outside write_scope", async () => {
    const { decision } = await runHook(
      { tool_name: "Write", tool_input: { file_path: `${VAULT}/work/X.md` } },
      readJournalOnly,
    );
    expect(decision.continue).toBe(false);
    expect(decision.stopReason).toMatch(/WRITE_SCOPE_DENIED/);
  });

  it("denies SYSTEM_DENY even when write_scope would allow", async () => {
    const env = {
      VOS_READ_PATHS: JSON.stringify([`${VAULT}/**`]),
      VOS_WRITE_PATHS: JSON.stringify([`${VAULT}/**`]),
      VOS_SYSTEM_DENY: JSON.stringify([`${VAULT}/agents/**`]),
    };
    const { decision } = await runHook(
      { tool_name: "Edit", tool_input: { file_path: `${VAULT}/agents/maya/agent.md` } },
      env,
    );
    expect(decision.continue).toBe(false);
    expect(decision.stopReason).toMatch(/SYSTEM_DENY/);
  });

  it("Bash: cat outside scope denies via read gate", async () => {
    const { decision } = await runHook(
      { tool_name: "Bash", tool_input: { command: "cat vault/work/active/X.md" } },
      {
        VOS_READ_PATHS: JSON.stringify([`${VAULT}/journal/**`]),
        VOS_WRITE_PATHS: JSON.stringify([`${VAULT}/journal/**`]),
        VOS_SYSTEM_DENY: JSON.stringify([]),
      },
    );
    expect(decision.continue).toBe(false);
  });

  it("Bash: shell substitution denies even with broad scope", async () => {
    const broad = {
      VOS_READ_PATHS: JSON.stringify([`${VAULT}/**`]),
      VOS_WRITE_PATHS: JSON.stringify([`${VAULT}/**`]),
      VOS_SYSTEM_DENY: JSON.stringify([]),
    };
    const { decision } = await runHook(
      { tool_name: "Bash", tool_input: { command: "cat $(ls vault/)" } },
      broad,
    );
    expect(decision.continue).toBe(false);
  });

  it("Bash: pwd allows without scope check", async () => {
    const { decision } = await runHook(
      { tool_name: "Bash", tool_input: { command: "pwd" } },
      readJournalOnly,
    );
    expect(decision.continue).toBe(true);
  });

  it("unknown tool: allow (out of scope)", async () => {
    const { decision } = await runHook(
      { tool_name: "WebFetch", tool_input: { url: "https://example.com" } },
      readJournalOnly,
    );
    expect(decision.continue).toBe(true);
  });

  it("exit 0 even when denying (CC reads decision from stdout)", async () => {
    const { exitCode } = await runHook(
      { tool_name: "Read", tool_input: { file_path: "/etc/passwd" } },
      readJournalOnly,
    );
    expect(exitCode).toBe(0);
  });
});
