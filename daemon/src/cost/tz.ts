// Resolve [startMs, endMs) for "today" in a named IANA TZ.
// Pure function — no Date.now() inside — so tests pass `now` explicitly.
export function dayRangeMs(now: number, tz: string): { startMs: number; endMs: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = Object.fromEntries(
    fmt.formatToParts(new Date(now)).map((p) => [p.type, p.value]),
  );
  if (parts.hour === "24") parts.hour = "00";
  const year = parts.year ?? "1970";
  const month = parts.month ?? "01";
  const day = parts.day ?? "01";
  const localMidnightWall = `${year}-${month}-${day}T00:00:00`;
  const startMs = wallTimeToUtcMs(localMidnightWall, tz);
  const tomorrowWall = nextDayWall(year, month, day);
  const endMs = wallTimeToUtcMs(tomorrowWall, tz);
  return { startMs, endMs };
}

function nextDayWall(y: string, m: string, d: string): string {
  const nextUtc = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + 1));
  const yy = nextUtc.getUTCFullYear();
  const mm = String(nextUtc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(nextUtc.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}T00:00:00`;
}

// Wall-clock string + IANA TZ → UTC ms.
// For ambiguous local midnight on fall-back days, picks the EARLIER UTC.
function wallTimeToUtcMs(wall: string, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const delta = (g: number): number => {
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(g)).map((p) => [p.type, p.value]),
    );
    if (parts.hour === "24") parts.hour = "00";
    const rendered = `${parts.year}-${parts.month}-${parts.day}T` +
      `${parts.hour}:${parts.minute}:${parts.second}`;
    return Date.parse(rendered + "Z") - g;
  };
  const guess = Date.parse(wall + "Z");
  // Probe both sides of any DST flip by computing offsets at guess ± 12h.
  const candA = guess - delta(guess - 12 * 3_600_000);
  const candB = guess - delta(guess + 12 * 3_600_000);
  // Keep only candidates that actually render back to `wall` in `tz`.
  const candidates = [candA, candB].filter((c) => delta(c) === guess - c);
  if (candidates.length === 0) {
    // Spring-forward gap — no valid UTC for this wall-clock.
    // Fall back to single-pass result; midnight never falls in the gap
    // window of any known TZ, so this branch is unreachable for callers
    // that pass midnight strings.
    return guess - delta(guess);
  }
  return Math.min(...candidates);
}

// Resolve TZ at daemon boot. Stored on ApiContext.
export function resolveTz(env: NodeJS.ProcessEnv): string {
  return env.VOID_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}
