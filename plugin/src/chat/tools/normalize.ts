// Output normalization helper, shared by tool UIs and replay code.
// Daemon `output` may be a plain string OR an array of {type:"text", text}
// content blocks (Anthropic-style). Always returns a string for display.

export function normalizeOutput(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((p) => {
        if (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string") {
          return (p as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  if (raw == null) return "";
  try { return JSON.stringify(raw); } catch { return String(raw); }
}
