# plugin/e2e — Playwright Electron + fake-Provider harness

End-to-end tests booting real Obsidian + built plugin + isolated void-os daemon.

## Prereqs

- macOS (v1 is macOS-headed only)
- Obsidian installed at `/Applications/Obsidian.app`
- bun (this repo's package manager)

## Run

```bash
cd plugin
bun run e2e
```

`globalSetup` builds the plugin into `plugin/e2e/fixtures/vault/.obsidian/plugins/void-os/`, picks a free port, spawns the daemon with `VOS_PROVIDER=fake` + `VOS_TITLER=stub` + tmpdir DB/vault, and writes per-run state to `<tmpdir>/state.json`. `globalTeardown` SIGTERMs the daemon and removes the tmpdir.

## Add a spec

Create `plugin/e2e/specs/<name>.spec.ts`:

```ts
import { test, expect, chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

test("...", async () => {
  const state = JSON.parse(readFileSync(process.env.VOS_E2E_STATE!, "utf8")) as {
    port: number;
    cdpPort: number;
    vaultPath: string;
    obsidianUserDataDir: string;
  };
  // Connect to the already-running Obsidian via CDP (launched by globalSetup).
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.cdpPort}`);
  try {
    const vaultPage = browser.contexts().flatMap(ctx => ctx.pages())
      .find(p => p.url() === "app://obsidian.md/index.html")!;
    // ...
  } finally {
    await browser.close();
  }
});
```

## Fake-Provider JSONL format

Each line is one `ProviderEvent` (see `daemon/src/providers/types.ts`). The empty-stream fixture (`fixtures/cc/empty.jsonl`) contains a single system init event.

Example chat round-trip canned stream:

```jsonl
{"type":"system","subtype":"init","session_id":"e2e"}
{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}
```

## data-testid convention

`data-testid="vos-<kebab-area>"`. v1 ships two: `vos-status-bar`, `vos-chat-root`. Per-spec tasks add more as needed.

## Known limitations (v1)

- macOS-headed only. Linux/CI deferred.
- One spec per run (workers: 1) — Electron + Obsidian don't tolerate parallel instances.
- Free-port → daemon-listen has a small TOCTOU window. Acceptable on a dev workstation; revisit before CI.
