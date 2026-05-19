#!/usr/bin/env bun
// scenarios/tinker-chat-open.ts
// Drive smoke Obsidian into "Tinker chat panel open with seeded conversation"
// and hand off to the operator.
//
// Pure WebSocket CDP — Playwright's connectOverCDP hangs against Electron
// 33.3.2's browser-level CDP, but raw WS to a page target works.

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";

const ID = process.argv[2] ?? "VOS-146";
const WORKTREE = `/Users/admin/hub-wt/${ID}`;
const SCRIPTS = `${WORKTREE}/workspace/void-os/scripts`;
const ROOT = `/tmp/void-os-smoke/${ID}`;

function cksum(s: string): number {
  return Number(execSync(`printf '%s' '${s}' | cksum | awk '{print $1}'`).toString().trim());
}
const CDP_PORT = 7900 + (cksum(ID) % 100);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollFetch<T>(url: string, predicate: (body: any) => T | null, timeoutMs: number): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.status === 200) {
        const body = await r.json().catch(() => null);
        const v = predicate(body);
        if (v !== null) return v;
      }
    } catch { /* not ready */ }
    await sleep(300);
  }
  throw new Error(`pollFetch timeout: ${url}`);
}

interface CdpClient {
  send(method: string, params?: any): Promise<any>;
  close(): void;
}
function openCdp(wsUrl: string): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    let nextId = 1;
    const settleOpen = () => resolve({
      send(method, params) {
        const id = nextId++;
        return new Promise<any>((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params: params ?? {} }));
        });
      },
      close() { try { ws.close(); } catch { /* noop */ } },
    });
    ws.onopen = settleOpen;
    ws.onerror = () => reject(new Error("CDP WS error"));
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data));
        if (typeof msg.id === "number") {
          const slot = pending.get(msg.id);
          if (!slot) return;
          pending.delete(msg.id);
          if (msg.error) slot.reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
          else slot.resolve(msg.result);
        }
      } catch { /* ignore non-JSON */ }
    };
  });
}

async function main(): Promise<void> {
  console.log(`[scenario] id=${ID}  cdp=${CDP_PORT}`);

  // 1. fresh smoke
  try { execSync(`${SCRIPTS}/smoke-down.sh --purge ${ID} >/dev/null 2>&1`); } catch { /* nothing */ }
  execSync(`${SCRIPTS}/smoke-up.sh --no-obsidian ${ID}`, { stdio: "inherit" });

  const token = fs.readFileSync(`${ROOT}/home/.void-os/token`, "utf8").trim();
  const port = JSON.parse(fs.readFileSync(`${ROOT}/home/.void-os/daemon.json`, "utf8")).port as number;
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${token}` };
  const json = { ...auth, "content-type": "application/json" };

  // 2. seed Tinker chat with a message that should provoke an `ask_user` call.
  //    Tinker's policy is "show draft and ask before writing" — proposing a
  //    new specialist agent reliably triggers the ask_user tool, which puts
  //    the chat into `input_required` waiting on the operator.
  const seedText =
    "I want you to create a new agent called Eva — my personal assistant for journaling and routine capture. " +
    "Draft the agent.md and ask me to confirm before writing it.";
  const c = await (await fetch(`${base}/chats`, { method: "POST", headers: json, body: JSON.stringify({ agent: "tinker" }) })).json();
  await fetch(`${base}/chat/${c.id}/message`, { method: "POST", headers: json, body: JSON.stringify({ text: seedText }) });

  // Wait for Tinker to land in input_required state (an ask_user tool call
  // is open). Fall back to "any assistant reply" if the model doesn't pick
  // ask_user — the chat is still useful even without a pending question.
  let inputRequired = false;
  let lastReply: string | null = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const meta = (await (await fetch(`${base}/chats`, { headers: auth })).json()) as Array<{ id: string; input_required: boolean }>;
    const row = meta.find((m) => m.id === c.id);
    if (row?.input_required) { inputRequired = true; break; }
    const msgs = (await (await fetch(`${base}/chat/${c.id}/messages`, { headers: auth })).json()) as Array<{ role: string; content: string }>;
    if (msgs.length > 1) lastReply = msgs[msgs.length - 1].content;
    if (row?.input_required || (lastReply && i > 30)) break;
  }
  console.log(`[scenario] chat=${c.id}  input_required=${inputRequired}  last_reply=${JSON.stringify(lastReply)?.slice(0, 200)}`);

  // 3. pin chatId in plugin data.json
  const dataPath = `${ROOT}/vault/.obsidian/plugins/void-os/data.json`;
  const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  data.chatId = c.id;
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));

  // 4. seed obsidian.json so the smoke vault is registered + trusted +
  //    auto-open, otherwise Obsidian shows the starter screen instead.
  //    Use the realpath'd vault path so Obsidian's basePath matches the
  //    daemon's vault_root (both end up under /private/tmp on macOS).
  //    Otherwise plugin compares /tmp/... vs /private/tmp/... → mismatch.
  const userData = `${ROOT}/obsidian-user-data`;
  fs.mkdirSync(userData, { recursive: true });
  const vaultPath = fs.realpathSync(`${ROOT}/vault`);
  const vaultId = String(cksum(vaultPath));
  const obsidianJson = {
    vaults: {
      [vaultId]: { path: vaultPath, ts: Date.now(), open: true, trusted: true },
    },
    updateDisabled: true,
  };
  fs.writeFileSync(`${userData}/obsidian.json`, JSON.stringify(obsidianJson, null, 2));

  // 4b. Kill ONLY a stale smoke Obsidian for this ID (matched by user-data-dir
  //     path). Never `pkill Obsidian` — that murders the operator's main app.
  //     If a prior scenario attempt orphaned an Obsidian holding the CDP port,
  //     it'll still be matched by the user-data-dir substring.
  try {
    execSync(`/usr/bin/pkill -f "user-data-dir=${userData}" 2>/dev/null`);
    await sleep(800);
  } catch { /* pkill returns non-zero if no match — fine */ }

  // 4c. Refuse to launch if some unrelated process holds the CDP port — we'd
  //     end up attaching to it instead of our Obsidian. Surface clearly so the
  //     operator can act (and we don't end up pkill'ing their main app).
  try {
    const lsof = execSync(`/usr/sbin/lsof -nP -iTCP:${CDP_PORT} -sTCP:LISTEN -t 2>/dev/null || true`).toString().trim();
    if (lsof) {
      throw new Error(
        `CDP port ${CDP_PORT} is already in use (pid ${lsof}). ` +
        `If this is a leftover smoke Obsidian: kill it with \`kill ${lsof}\`. ` +
        `If it's your main Obsidian, change CDP_PORT in the scenario script.`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("CDP port")) throw e;
    /* lsof not present or no listener — fine */
  }

  // 5. launch Obsidian via `open -na` (direct exec gets LaunchServices-routed
  //    to the operator's running instance on macOS, defeating CDP).
  spawn("/usr/bin/open", [
    "-na", "Obsidian", "--args",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userData}`,
    vaultPath,
  ], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, HOME: `${ROOT}/home` },
  }).unref();
  console.log(`[scenario] obsidian launching (open -na)`);

  // 6. wait for CDP target listing the vault page (not starter.html)
  const target = await pollFetch<{ webSocketDebuggerUrl: string; url: string }>(
    `http://127.0.0.1:${CDP_PORT}/json`,
    (body) => {
      if (!Array.isArray(body)) return null;
      const t = body.find((x: any) => typeof x.url === "string" && x.url.includes("obsidian.md/index.html"));
      return t ?? null;
    },
    30_000,
  );
  console.log(`[scenario] cdp target url=${target.url}`);

  // 7. raw WS CDP connect
  const cdp = await openCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");

  // 8. poll for the Trust-author modal (Obsidian renders it post-load — a
  //    single shot before the modal mounts always misses) then click.
  let trusted: string = "not-yet";
  for (let i = 0; i < 40; i++) {
    const r: any = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const btn = [...document.querySelectorAll('button')].find(b => /Trust author/i.test(b.textContent || ''));
        if (btn) { btn.click(); return 'trusted'; }
        return 'no-modal';
      })()`,
      returnByValue: true,
    });
    trusted = r?.result?.value;
    if (trusted === "trusted") break;
    await sleep(500);
  }
  console.log(`[scenario] trust-modal: ${trusted}`);

  // Give Obsidian a beat to finish dismissing the modal before we touch plugins.
  await sleep(1200);

  // 9. enable plugin (retry once if app or plugin registry isn't ready)
  let enableValue: string = "";
  for (let i = 0; i < 5; i++) {
    const enableRes: any = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const app = window.app;
        if (!app || !app.plugins) return 'no-app';
        if (app.plugins.enabledPlugins?.has?.('void-os')) return 'already-enabled';
        await app.plugins.enablePlugin('void-os');
        return 'enabled';
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    enableValue = enableRes?.result?.value;
    if (enableValue === "enabled" || enableValue === "already-enabled") break;
    await sleep(800);
  }
  console.log(`[scenario] enable plugin: ${enableValue}`);

  // 10. wait for status bar text "connected"
  let connected = false;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const sb: any = await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="vos-status-bar"]')?.textContent ?? null`,
      returnByValue: true,
    });
    const text = sb?.result?.value;
    if (text && /connected/i.test(text)) {
      console.log(`[scenario] status-bar: ${text}`);
      connected = true;
      break;
    }
  }
  if (!connected) console.log(`[scenario] WARN: status-bar didn't reach "connected" — plugin may still be initialising`);

  // 11. Obsidian likes to pop the Community-plugins Settings tab open after
  //     a fresh enablePlugin. Close any visible modal first, otherwise the
  //     chat view opens behind it and the operator lands on Settings.
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const close = () => {
        const btn = document.querySelector('.modal-close-button');
        if (btn) { btn.click(); return true; }
        return false;
      };
      let closed = 0;
      for (let i = 0; i < 3; i++) {
        if (close()) closed++;
      }
      return closed;
    })()`,
    returnByValue: true,
  }).then((r: any) => console.log(`[scenario] dismissed ${r?.result?.value} modal(s)`));

  await sleep(400);

  // 12. open chat view (and verify the leaf actually becomes active)
  await cdp.send("Runtime.evaluate", {
    expression: `window.app.commands.executeCommandById('void-os:open-chat-view')`,
    awaitPromise: true,
    returnByValue: true,
  });

  // Re-close any Settings modal Obsidian may have re-opened, then re-issue
  // the chat-view command if the leaf isn't visible yet.
  for (let i = 0; i < 6; i++) {
    await sleep(400);
    const check: any = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const close = document.querySelector('.modal-close-button');
        if (close) close.click();
        return {
          modalOpen: !!document.querySelector('.modal-container'),
          chatRoot: !!document.querySelector('[data-testid="vos-chat-root"]'),
        };
      })()`,
      returnByValue: true,
    });
    const { modalOpen, chatRoot } = check.result.value;
    if (chatRoot && !modalOpen) { console.log(`[scenario] chat view visible (no modal)`); break; }
    if (!chatRoot) {
      await cdp.send("Runtime.evaluate", {
        expression: `window.app.commands.executeCommandById('void-os:open-chat-view')`,
        awaitPromise: true,
        returnByValue: true,
      });
    }
    if (i === 5) console.log(`[scenario] WARN: chat view not visible after retries (modal=${modalOpen}, root=${chatRoot})`);
  }

  cdp.close();

  console.log("");
  console.log("=== READY ===");
  console.log(`  vault:        ${ROOT}/vault`);
  console.log(`  daemon:       ${base}`);
  console.log(`  chat:         ${c.id}`);
  console.log(`  obsidian CDP: http://127.0.0.1:${CDP_PORT}`);
  console.log(`  tear down:    ${SCRIPTS}/smoke-down.sh --purge ${ID}`);
}

main().catch((e) => {
  console.error("[scenario] FAILED:", e);
  process.exit(1);
});
