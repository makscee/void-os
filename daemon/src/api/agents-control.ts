// VOS-161: agent control verb routes — POST /agents/:id/{pause,resume,kill}.
// VOS-162: + POST /agents/:id/branch — fork an agent into a new worktree.
//
// The intervention model on top of the VOS-155/160 inspector:
//   - POST /agents/:id/pause   → soft pause (wait-for-checkpoint)
//   - POST /agents/:id/resume  → clear a pause
//   - POST /agents/:id/kill    → hard kill (interrupt + abort)
//   - POST /agents/:id/branch  → git-worktree fork from the repo's HEAD
//
// pause/resume/kill resolve the agent's live control handle from the
// `AgentControlRegistry`. A handle exists only while the agent is running;
// once the run reaches a terminal state dispatch-child deregisters it. So an
// unknown id (never spawned, or already terminal) returns 404 — the same
// shape POST /chat/:id/cancel uses for a missing chat.
//
// VOS-162: `branch` is different — it operates on git state, not the live
// run, so it works for ANY agent the inflight registry has observed
// (running OR within the ended-grace window). Its 404 boundary is "the
// inflight registry has never seen this agent_id".
//
// Each verb also emits an `agent.event` (kind=status) so the inspector trace
// records the intervention alongside the run's own frames.
//
// Auth: mounted behind `makeRequireAuth` in app.ts, mirroring /agents/inflight.

import type { Hono } from "hono";
import type { EventBus } from "../events/index.ts";
import type { AgentControlRegistry } from "../agents/control.ts";
import type { InflightRegistry } from "../agents/inflight.ts";
import { branchAgent, type BranchAgentDeps } from "../agents/branch.ts";

export interface MountAgentsControlDeps {
  bus: EventBus;
  control: AgentControlRegistry;
  /** VOS-162: snapshot registry — the branch route 404s on an agent_id it
   *  has never observed. */
  inflight: InflightRegistry;
  /** VOS-162: the git repo to branch — the daemon's chat cwd / vault root. */
  repoRoot: string;
  /** VOS-162: test seam — overrides for branchAgent's git spawn + paths. */
  branchOverrides?: Partial<Pick<BranchAgentDeps, "runGit" | "worktreeParent" | "nonce">>;
}

type Verb = "pause" | "resume" | "kill";

const VERB_SUMMARY: Record<Verb, string> = {
  pause: "operator paused agent (soft pause — wait-for-checkpoint)",
  resume: "operator resumed agent",
  kill: "operator killed agent (hard kill — interrupt + abort)",
};

export function mountAgentsControl(app: Hono, deps: MountAgentsControlDeps): void {
  const handle = (verb: Verb) => (c: import("hono").Context) => {
    const agentId = c.req.param("id");
    const ctrl = deps.control.get(agentId);
    if (!ctrl) {
      // Unknown id, or the run already reached a terminal state and
      // dispatch-child deregistered the handle.
      return c.json({ error: "not_found" }, 404);
    }

    if (verb === "pause") ctrl.requestPause();
    else if (verb === "resume") ctrl.requestResume();
    else ctrl.requestKill();

    // Record the intervention on the event substrate so it shows in the
    // inspector trace. Best-effort: a missing parent_id is fine.
    deps.bus.emit({
      type: "agent.event",
      payload: {
        ts: new Date().toISOString(),
        agent_id: agentId,
        parent_id: null,
        kind: "status",
        summary: VERB_SUMMARY[verb],
        state: ctrl.state(),
      },
    });

    return c.json({ agent_id: agentId, control_state: ctrl.state() });
  };

  app.post("/agents/:id/pause", handle("pause"));
  app.post("/agents/:id/resume", handle("resume"));
  app.post("/agents/:id/kill", handle("kill"));

  // VOS-162: branch verb. Forks the agent's repo at HEAD into a new
  // worktree. Unlike the control verbs, it does not need a live run
  // handle — it works for any agent the inspector still shows.
  app.post("/agents/:id/branch", async (c) => {
    const agentId = c.req.param("id");
    if (!deps.inflight.get(agentId)) {
      // The inflight registry has never observed (or has purged) this
      // agent — nothing to branch from.
      return c.json({ error: "not_found" }, 404);
    }

    let result;
    try {
      result = await branchAgent(agentId, {
        repoRoot: deps.repoRoot,
        runGit: deps.branchOverrides?.runGit,
        worktreeParent: deps.branchOverrides?.worktreeParent,
        nonce: deps.branchOverrides?.nonce,
      });
    } catch (e) {
      // A git failure (non-repo cwd, worktree-add conflict) is a 500 —
      // the request was well-formed; the host git state was not.
      return c.json(
        { error: "branch_failed", detail: e instanceof Error ? e.message : String(e) },
        500,
      );
    }

    // Record the branch on the event substrate so it shows in the trace.
    deps.bus.emit({
      type: "agent.event",
      payload: {
        ts: new Date().toISOString(),
        agent_id: agentId,
        parent_id: null,
        kind: "status",
        summary: `operator branched agent → ${result.worktree_path}`,
        source: "daemon",
      },
    });

    return c.json(result);
  });
}
