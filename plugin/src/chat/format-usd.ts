export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "$0.00";
  if (n < 0.005) return "$0.00";
  return "$" + n.toFixed(2);
}
