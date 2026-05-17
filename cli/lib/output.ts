export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…".slice(0, max);
  return s.slice(0, max - 1) + "…";
}

export interface Column {
  key: string;
  width: number;
}

export function renderTable(rows: Array<Record<string, unknown>>, cols: Column[]): string {
  return rows
    .map((row) =>
      cols
        .map((c) => truncate(String(row[c.key] ?? ""), c.width).padEnd(c.width))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
