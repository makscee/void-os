// Resolution of the HTTP + WS origins the plugin uses to talk to its daemon.
//
// Extracted from main.ts (VOS-146 T9) so the resolution can be unit-tested
// without pulling in obsidian/node-runtime imports that the main entrypoint
// requires.

import type { DaemonAttachment } from "./daemon-lifecycle";

/** Build the http+ws origins the plugin talks to.
 *
 *  Resolution order:
 *  1. `daemonUrl` (if a non-empty string) — operator pinned this URL
 *     explicitly (via the settings tab, or via a smoke-harness seeded
 *     `data.json`). Trust it. Derive ws by swapping http→ws / https→wss
 *     and appending /events.
 *  2. The attachment's port from ensureDaemon — the default production path.
 *     Whatever ensureDaemon returned is what's actually listening locally.
 *
 *  Falls back to (2) silently if (1) is malformed, so a typo in the
 *  settings tab never bricks the plugin.
 *
 *  Why both signals exist:
 *  - production: no daemonUrl set → use the attachment-derived URL the
 *    ensureDaemon probe just confirmed is alive.
 *  - smoke harness: smoke-up.sh seeds data.json with
 *    `http://127.0.0.1:<per-id-port>` so the isolated Obsidian's plugin
 *    targets its own smoke daemon instead of the operator's main daemon
 *    on 7777. (HOME inheritance alone isn't a strong enough seam — the
 *    operator's main daemon may be co-running on a different port and
 *    the user may have local agents pinning a daemonUrl anyway.)
 */
export function urlsFromAttachment(
  att: DaemonAttachment,
  daemonUrl?: string,
): { http: string; ws: string } {
  if (typeof daemonUrl === "string" && daemonUrl.length > 0) {
    try {
      const u = new URL(daemonUrl);
      const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
      const http = `${u.protocol}//${u.host}`;
      const ws = `${wsProto}//${u.host}/events`;
      return { http, ws };
    } catch {
      // malformed URL — fall through to attachment-based defaults
    }
  }
  const http = `http://127.0.0.1:${att.port}`;
  const ws = `ws://127.0.0.1:${att.port}/events`;
  return { http, ws };
}
