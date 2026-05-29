// render.ts — HTML string templates for dashboard, iframe shell, placeholder, working page (Task 9)
import type { CatalogSkill } from "./catalog.ts";
import type { SessionInfo } from "./sessions.ts";

/** Escape HTML special chars to prevent XSS in string templates. */
const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/**
 * Placeholder body written BEFORE the vc process starts so the iframe shows
 * something while the session cold-starts (no 404 during cold start).
 */
export function placeholderBody(): string {
  return `<!doctype html><title>session starting…</title>
<body style="font:16px system-ui;padding:2rem;color:#666">session starting…</body>`;
}

/**
 * "Working" interstitial shown after submitting an answer-back form.
 * The SSE stream will trigger an iframe reload when body.html advances.
 */
export function workingPage(): string {
  return `<!doctype html><title>working…</title>
<body style="font:16px system-ui;padding:2rem;color:#666">received — working…</body>`;
}

/**
 * Main dashboard: skill launch buttons + session list + relay auth banner.
 */
export function renderDashboard(
  skills: CatalogSkill[],
  sessions: SessionInfo[],
  relay: { authed: boolean },
): string {
  const skillBtns = skills
    .map(
      (s) => `
    <form action="/launch" method="POST" class="skill">
      <input type="hidden" name="skill" value="${esc(s.name)}">
      <button type="submit">${esc(s.name)}</button>
      <span>${esc(s.description)}</span>
      <input name="text" placeholder="optional input…">
    </form>`,
    )
    .join("");

  const rows = sessions
    .map(
      (s) => `
    <li><a href="/s/${esc(s.uuid)}">${esc(s.title)}</a>${s.error ? " ⚠️" : ""}</li>`,
    )
    .join("");

  const banner = relay.authed
    ? `<div class="ok">relay: authed ✓</div>`
    : `<div class="bad">relay: not authed ✗ — run <code>vc login</code></div>`;

  return `<!doctype html><meta charset=utf8><title>void-os</title>
<style>body{font:16px system-ui;max-width:48rem;margin:2rem auto}
.ok{color:#070}.bad{color:#a00}.skill{margin:.5rem 0}button{font-size:1rem}</style>
<h1>void-os</h1>${banner}
<h2>skills</h2>${skillBtns}
<h2>sessions</h2><ul>${rows}</ul>`;
}

/**
 * Iframe shell: wraps a session's body.html in a header with a back link,
 * the inspect command, and SSE-driven auto-reload.
 */
export function renderShell(uuid: string, vault: string): string {
  // The resume command must be run from the vault dir because CC uses cwd to locate sessions.
  const resumeCmd = `cd ${esc(vault)} && vc -- --resume ${esc(uuid)}`;
  return `<!doctype html><meta charset=utf8><title>session ${esc(uuid)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}
body{font:14px system-ui}header{padding:.5rem 1rem;background:#111;color:#eee;display:flex;gap:1rem;align-items:center}
code{background:#333;padding:.2rem .4rem;border-radius:3px}iframe{border:0;width:100%;height:calc(100vh - 44px)}</style>
<header><a href="/" style="color:#9cf">← all</a>
<span>inspect: <code>${resumeCmd}</code></span></header>
<iframe id="f" src="/s/${esc(uuid)}/body"></iframe>
<script>
const es = new EventSource("/s/${esc(uuid)}/stream");
es.onmessage = () => document.getElementById("f").contentWindow.location.reload();
</script>`;
}
