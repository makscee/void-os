// CC spawner. Invokes `claudev claude ...` subprocess. T4 owns implementation.

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

export const createCcSpawner = (): CcSpawner => {
  throw new Error("not implemented");
};
