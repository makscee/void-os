# e2e/lxc — Fresh-LXC end-to-end test for VOS-121

Provisions a Proxmox LXC on `tower`, installs the void-os stack from a rsync'd
working tree, runs `void-os init --non-interactive` + `void-os ask tinker`,
asserts vault state, then destroys the LXC.

## Prerequisites

- SSH access to tower as root: `ssh root@tower true` must succeed silently.
- `bun` installed locally (host runs `bun test`).
- A one-shot claudev access code. Mint with:

  ```
  VOID_AUTH_ADMIN_TOKEN=<token> ./tools/mint-claudev-code.sh
  ```

  Or use the admin UI at admin.makscee.ru.

## Local run

```
CLAUDEV_ACCESS_CODE=XXXX-XXXX ./e2e/lxc/run.sh
```

Runs in ~3-4 minutes typical, 5 minute ceiling.

The suite is gated on `VOS_E2E_LIVE=1` (set by `run.sh`). Without that env var
the spec is skipped, so plain `bun test` at the repo root will not attempt to
provision Proxmox containers.

## Debugging

- `KEEP_LXC=1` — skip the post-test destroy; LXC stays on tower for inspection.
  `ssh root@tower` then `pct enter <ctid>` to debug.
- `TOWER_HOST=other-host.tailnet.ts.net` — point at a different Proxmox host.
- Per-test logs print to stderr in the dump phase before destroy.

## Known issues

- One-shot codes: each run consumes a fresh access code. Re-running needs a
  new mint. The `KEEP_LXC=1` flag is the workaround for tight debug loops.
- Concurrent local runs serialize via tower-side `flock /var/lock/vos-e2e-ctid`;
  the CI `concurrency.group: lxc-e2e` only serializes CI runs.
- claudev is pinned in `e2e/lxc/.claudev-version`. Bumps go through PR review.

## Files

- `init-non-interactive.spec.ts` — the test
- `lib/lxc.ts` — provision/exec/destroy with flock
- `lib/rsync.ts` — host→tower→LXC sync
- `lib/setup.ts` — apt + bun + pinned claudev install
- `lib/diagnostics.ts` — pre-destroy log dump
- `.claudev-version` — pinned claudev git ref
- `run.sh` — entry point
