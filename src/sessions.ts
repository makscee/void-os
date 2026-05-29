// sessions.ts — list sessions sorted by body.html mtime (Task 5)
export interface SessionInfo { uuid: string; title: string; mtimeMs: number; error: boolean; }
export function listSessions(_vault: string): SessionInfo[] { throw new Error("not implemented"); }
