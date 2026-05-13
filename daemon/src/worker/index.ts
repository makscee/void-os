// Worker orchestrator. Spawns git-isolated worktree tasks for long-running code work.

export interface WorktreeTaskSpec {
  repoPath: string;
  prompt: string;
  agent?: string;
}

export interface WorkerOrchestrator {
  spawn(spec: WorktreeTaskSpec): Promise<{ runId: string; worktree: string }>;
  status(runId: string): Promise<"pending" | "running" | "done" | "failed">;
  cancel(runId: string): Promise<void>;
}

export const createWorkerOrchestrator = (): WorkerOrchestrator => {
  throw new Error("not implemented");
};
