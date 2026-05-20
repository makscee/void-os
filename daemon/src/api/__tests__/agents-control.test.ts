// VOS-161: tests for the pause/kill/resume verb routes.
// VOS-162: + the branch verb route.
//
// Covers:
//   - each verb 200s against a registered agent and echoes control_state
//   - pause→resume round-trip via the HTTP surface
//   - kill flips state to "killed" and the route reports it
//   - an unknown agent_id 404s
//   - a deregistered (terminal) agent_id 404s
//   - each verb emits an agent.event (kind=status) on the bus
//   - VOS-162: branch 200s for an inflight-known agent, 404s for an
//     unknown one, 500s on a git failure, and emits a status event

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createEventBus, type DaemonEvent } from "../../events/index.ts";
import { createAgentControlRegistry } from "../../agents/control.ts";
import { createInflightRegistry } from "../../agents/inflight.ts";
import { mountAgentsControl } from "../agents-control.ts";

/**
 * VOS-162: a fake git runner. Returns a canned HEAD sha and a 0-exit
 * worktree-add unless `failOn` matches the first arg.
 */
function fakeGit(opts: { headSha?: string; failOn?: string } = {}) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args);
      if (opts.failOn && args[0] === opts.failOn) {
        return { stdout: "", stderr: "fatal: simulated git failure", exitCode: 1 };
      }
      if (args[0] === "rev-parse") {
        return { stdout: (opts.headSha ?? "a".repeat(40)) + "\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

function makeHarness(gitOpts: { headSha?: string; failOn?: string } = {}) {
  const bus = createEventBus();
  const control = createAgentControlRegistry();
  const inflight = createInflightRegistry({ bus, control });
  const git = fakeGit(gitOpts);
  const app = new Hono();
  mountAgentsControl(app, {
    bus,
    control,
    inflight,
    repoRoot: "/tmp/fake-repo",
    branchOverrides: {
      runGit: git.run,
      worktreeParent: "/tmp/fake-repo-wt",
      nonce: () => "n1",
    },
  });
  const events: DaemonEvent[] = [];
  bus.subscribe("agent.event", (ev) => events.push(ev));
  // Seed an inflight row by emitting a spawn event for "agent-1".
  const seedInflight = (agentId: string) => {
    bus.emit({
      type: "agent.event",
      payload: {
        ts: new Date().toISOString(),
        agent_id: agentId,
        parent_id: null,
        kind: "spawn",
        summary: "seed",
      },
    });
  };
  return { app, control, inflight, events, git, seedInflight };
}

async function post(app: Hono, agentId: string, verb: string) {
  return app.fetch(
    new Request(`http://x/agents/${agentId}/${verb}`, { method: "POST" }),
  );
}

describe("VOS-161: agent control verb routes", () => {
  test("pause then resume round-trips control_state", async () => {
    const { app, control } = makeHarness();
    control.register("agent-1", () => {});

    const pauseRes = await post(app, "agent-1", "pause");
    expect(pauseRes.status).toBe(200);
    expect(await pauseRes.json()).toEqual({
      agent_id: "agent-1",
      control_state: "paused",
    });
    expect(control.stateOf("agent-1")).toBe("paused");

    const resumeRes = await post(app, "agent-1", "resume");
    expect(resumeRes.status).toBe(200);
    expect(await resumeRes.json()).toEqual({
      agent_id: "agent-1",
      control_state: "running",
    });
    expect(control.stateOf("agent-1")).toBe("running");
  });

  test("kill flips state to killed and fires the abort hook", async () => {
    const { app, control } = makeHarness();
    let killed = false;
    control.register("agent-1", () => {
      killed = true;
    });

    const res = await post(app, "agent-1", "kill");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      agent_id: "agent-1",
      control_state: "killed",
    });
    expect(killed).toBe(true);
    expect(control.stateOf("agent-1")).toBe("killed");
  });

  test("unknown agent_id 404s", async () => {
    const { app } = makeHarness();
    for (const verb of ["pause", "resume", "kill"]) {
      const res = await post(app, "nope", verb);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  test("a deregistered (terminal) agent 404s", async () => {
    const { app, control } = makeHarness();
    control.register("agent-1", () => {});
    control.deregister("agent-1");

    const res = await post(app, "agent-1", "kill");
    expect(res.status).toBe(404);
  });

  test("each verb emits an agent.event status frame", async () => {
    const { app, control, events } = makeHarness();
    control.register("agent-1", () => {});

    await post(app, "agent-1", "pause");
    await post(app, "agent-1", "resume");
    await post(app, "agent-1", "kill");

    expect(events).toHaveLength(3);
    for (const ev of events) {
      const p = ev.payload as { agent_id: string; kind: string; state: string };
      expect(p.agent_id).toBe("agent-1");
      expect(p.kind).toBe("status");
      expect(["running", "paused", "killed"]).toContain(p.state);
    }
    // The kill frame must report the killed state.
    const last = events[2]!.payload as { state: string };
    expect(last.state).toBe("killed");
  });
});

describe("VOS-162: branch verb route", () => {
  test("branch 200s for an inflight-known agent and returns the worktree", async () => {
    const { app, git, seedInflight } = makeHarness({ headSha: "b".repeat(40) });
    seedInflight("agent-1");

    const res = await post(app, "agent-1", "branch");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent_id: string;
      worktree_path: string;
      branch: string;
      base_sha: string;
    };
    expect(body.agent_id).toBe("agent-1");
    expect(body.base_sha).toBe("b".repeat(40));
    expect(body.branch).toBe("branch/agent1-n1");
    expect(body.worktree_path).toBe("/tmp/fake-repo-wt/agent1-n1");
    // git was driven: rev-parse HEAD, then worktree add.
    expect(git.calls[0]).toEqual(["rev-parse", "HEAD"]);
    expect(git.calls[1]![0]).toBe("worktree");
    expect(git.calls[1]).toContain("b".repeat(40));
  });

  test("branch 404s for an agent the inflight registry never observed", async () => {
    const { app } = makeHarness();
    const res = await post(app, "ghost", "branch");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("branch works for an ended agent (git state, not a live handle)", async () => {
    const { app, seedInflight } = makeHarness();
    seedInflight("agent-1");
    // No control handle ever registered → control verbs would 404, but
    // branch operates on git state and the inflight row still exists.
    const res = await post(app, "agent-1", "branch");
    expect(res.status).toBe(200);
  });

  test("branch 500s when git fails", async () => {
    const { app, seedInflight } = makeHarness({ failOn: "rev-parse" });
    seedInflight("agent-1");
    const res = await post(app, "agent-1", "branch");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("branch_failed");
  });

  test("branch emits an agent.event recording the fork", async () => {
    const { app, events, seedInflight } = makeHarness();
    seedInflight("agent-1");
    const before = events.length;
    await post(app, "agent-1", "branch");
    const branchEvents = events.slice(before);
    expect(branchEvents).toHaveLength(1);
    const p = branchEvents[0]!.payload as { kind: string; summary: string };
    expect(p.kind).toBe("status");
    expect(p.summary).toContain("branched agent");
  });
});

// ---------------------------------------------------------------------------
// VOS-165: POST /agents/branch/prune — GC the worktrees the branch verb left.
// ---------------------------------------------------------------------------

/** A fake git for prune-route tests: canned `worktree list`, recorded removes. */
function fakePruneGit(listOutput: string) {
  const removed: string[] = [];
  return {
    removed,
    run: async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return { stdout: listOutput, stderr: "", exitCode: 0 };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        removed.push(args[args.length - 1]);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

const PRUNE_LIST =
  `worktree /repo\nHEAD ${"0".repeat(40)}\nbranch refs/heads/main\n\n` +
  `worktree /repo-wt/agent1-1\nHEAD ${"0".repeat(40)}\nbranch refs/heads/branch/agent1-1\n`;

function makePruneHarness(
  git: ReturnType<typeof fakePruneGit>,
  mtimeOf?: (p: string) => number,
  now?: () => number,
) {
  const bus = createEventBus();
  const control = createAgentControlRegistry();
  const inflight = createInflightRegistry({ bus, control });
  const app = new Hono();
  mountAgentsControl(app, {
    bus,
    control,
    inflight,
    repoRoot: "/repo",
    pruneOverrides: { runGit: git.run, mtimeOf, now },
  });
  const events: DaemonEvent[] = [];
  bus.subscribe("agent.event", (ev) => events.push(ev));
  return { app, events };
}

async function postPrune(app: Hono, body?: unknown) {
  return app.fetch(
    new Request("http://x/agents/branch/prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? "{}" : JSON.stringify(body),
    }),
  );
}

describe("VOS-165: POST /agents/branch/prune", () => {
  test("200s with a report and removes the branch/* worktree", async () => {
    const git = fakePruneGit(PRUNE_LIST);
    const { app } = makePruneHarness(git);
    const res = await postPrune(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pruned: Array<{ path: string }>;
      kept: unknown[];
      failed: unknown[];
    };
    expect(body.pruned.map((w) => w.path)).toEqual(["/repo-wt/agent1-1"]);
    expect(body.kept).toHaveLength(0);
    expect(body.failed).toHaveLength(0);
    expect(git.removed).toEqual(["/repo-wt/agent1-1"]);
  });

  test("emits an agent.event recording the sweep", async () => {
    const git = fakePruneGit(PRUNE_LIST);
    const { app, events } = makePruneHarness(git);
    await postPrune(app);
    expect(events).toHaveLength(1);
    const p = events[0].payload as { kind: string; summary: string };
    expect(p.kind).toBe("status");
    expect(p.summary).toContain("pruned 1 branch worktree");
  });

  test("older_than_minutes keeps a recently-touched worktree", async () => {
    const git = fakePruneGit(PRUNE_LIST);
    const NOW = 2_000_000_000_000;
    // Worktree mtime is 30s old; cutoff is 1 min → kept.
    const { app } = makePruneHarness(git, () => NOW - 30_000, () => NOW);
    const res = await postPrune(app, { older_than_minutes: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pruned: unknown[]; kept: Array<{ path: string }> };
    expect(body.pruned).toHaveLength(0);
    expect(body.kept.map((w) => w.path)).toEqual(["/repo-wt/agent1-1"]);
    expect(git.removed).toHaveLength(0);
  });

  test("a negative older_than_minutes is a 400", async () => {
    const git = fakePruneGit(PRUNE_LIST);
    const { app } = makePruneHarness(git);
    const res = await postPrune(app, { older_than_minutes: -5 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
  });

  test("a worktree-list failure surfaces as a 500", async () => {
    const failGit = {
      removed: [] as string[],
      run: async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return { stdout: "", stderr: "fatal: not a git repository", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const { app } = makePruneHarness(failGit);
    const res = await postPrune(app);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("prune_failed");
  });
});
