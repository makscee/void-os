/**
 * TTY detection + ANSI helpers for CLI output.
 *
 * Use `useColor(stream)` to decide whether escapes should be emitted (based
 * on the stream's `isTTY`). Use `ansi(enabled)` to obtain a small set of
 * color wrappers; when `enabled` is false they are no-ops. `stripAnsi`
 * removes SGR sequences (handy in tests).
 */

export function isTTY(stream: { isTTY?: boolean }): boolean {
  return stream.isTTY === true;
}

export function useColor(stream: { isTTY?: boolean }): boolean {
  return isTTY(stream);
}

export interface Ansi {
  dim(s: string): string;
  red(s: string): string;
}

export function ansi(enabled: boolean): Ansi {
  const wrap = (open: string) => (s: string) =>
    enabled ? `${open}${s}\x1b[0m` : s;
  return {
    dim: wrap("\x1b[2m"),
    red: wrap("\x1b[31m"),
  };
}

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_SGR_RE, "");
}
