export function formatTokens(n: number | null): string {
  if (n == null) return "—";
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 999_500) {
    const v = n / 1000;
    return `${v.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const v = n / 1_000_000;
  const str = v.toFixed(1);
  return `${n % 1_000_000 === 0 ? str.replace(/\.0$/, "") : str}M`;
}
