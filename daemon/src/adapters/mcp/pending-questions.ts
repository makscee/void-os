export interface PendingRegistry {
  register(toolUseId: string, deadlineMs: number): Promise<string>;
  resolve(toolUseId: string, answer: string): boolean;
  cancelAll(): void;
  size(): number;
}

interface Awaiter {
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createPendingRegistry(): PendingRegistry {
  const map = new Map<string, Awaiter>();

  return {
    register(toolUseId, deadlineMs) {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (map.delete(toolUseId)) {
            reject(new Error("ASK_USER_TIMEOUT"));
          }
        }, deadlineMs);
        map.set(toolUseId, { resolve, reject, timer });
      });
    },
    resolve(toolUseId, answer) {
      const a = map.get(toolUseId);
      if (!a) return false;
      clearTimeout(a.timer);
      map.delete(toolUseId);
      a.resolve(answer);
      return true;
    },
    cancelAll() {
      for (const [id, a] of map) {
        clearTimeout(a.timer);
        a.reject(new Error("ASK_USER_CANCELLED"));
      }
      map.clear();
    },
    size() {
      return map.size;
    },
  };
}
