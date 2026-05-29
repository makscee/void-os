// preflight.ts — prerequisite checks (Task 7)
export interface PreflightResult { ok: boolean; missing: string[]; }
export async function checkPreflight(): Promise<PreflightResult> { throw new Error("not implemented"); }
