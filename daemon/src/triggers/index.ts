// Trigger registry. Dispatches schedule/webhook runs. V1: cron only.

export interface TriggerFire {
  skill: string;
  inputs: Record<string, unknown>;
  agent?: string;
}

export interface Trigger {
  start(): void;
  stop(): void;
  onFire(callback: (fire: TriggerFire) => void): void;
}

export interface TriggerRegistry {
  register(name: string, trigger: Trigger): void;
  unregister(name: string): void;
  list(): string[];
}

export const createTriggerRegistry = (): TriggerRegistry => {
  throw new Error("not implemented");
};
