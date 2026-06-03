// render.ts — HTML string templates for dashboard, iframe shell, placeholder, working page (Task 9)
import type { SessionInfo, SessionStatus } from "./sessions.ts";
import { DEFAULT_RUNNERS, DEFAULT_RUNNER_LABEL } from "./paths.ts";
import type { Runner } from "./paths.ts";
import type { Decision } from "./decision.ts";

/** Escape HTML special chars to prevent XSS in string templates. */
export const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// Shared ui-kit tokens (shadcn slate dark) — inlined so the dashboard is self-contained.
const UI_TOKENS = `
:root {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
  --card: 222.2 84% 4.9%;
  --card-foreground: 210 40% 98%;
  --primary: 210 40% 98%;
  --primary-foreground: 222.2 47.4% 11.2%;
  --secondary: 217.2 32.6% 17.5%;
  --secondary-foreground: 210 40% 98%;
  --muted: 217.2 32.6% 17.5%;
  --muted-foreground: 215 20.2% 65.1%;
  --accent: 217.2 32.6% 17.5%;
  --accent-foreground: 210 40% 98%;
  --destructive: 0 62.8% 30.6%;
  --destructive-foreground: 210 40% 98%;
  --border: 217.2 32.6% 17.5%;
  --input: 217.2 32.6% 17.5%;
  --ring: 212.7 26.8% 83.9%;
  --radius: 0.5rem;
}`;

/**
 * Placeholder body written BEFORE the vc process starts so the iframe shows
 * something while the session cold-starts (no 404 during cold start).
 *
 * Self-updating: a client-side timer ticks the elapsed clock and escalates the
 * status message (cold starts run ~30s–3min; research-style skills 5–8min), so
 * the page reads as "still working" rather than a frozen "session starting…".
 * The script runs inside the iframe for the whole cold start — the SSE only
 * swaps it out once the skill writes real body.html.
 */
export function placeholderBody(skill = ""): string {
  const label = (skill || "session").replace(/[<>&"]/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${label} — starting…</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0f;color:#d4d4d8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
  .card{text-align:center;max-width:30rem}
  .spinner{width:38px;height:38px;border:3px solid #272738;border-top-color:#a78bfa;border-radius:50%;margin:0 auto 1.5rem;animation:spin .9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:1.15rem;font-weight:600;color:#e4e4e7;margin-bottom:.6rem}
  .skill{color:#a78bfa}
  .status{color:#a1a1aa;font-size:.95rem;min-height:1.4em}
  .elapsed{margin-top:1rem;font-size:.8rem;color:#52525b;font-variant-numeric:tabular-nums}
</style></head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>Launching <span class="skill">${label}</span></h1>
    <div class="status" id="st">Starting Claude Code…</div>
    <div class="elapsed" id="el">0:00</div>
  </div>
  <script>
    var start=Date.now();
    var stages=[[0,"Starting Claude Code…"],[15,"Warming up the session…"],[45,"Loading the ${label} skill…"],[90,"Working — cold starts can take a few minutes…"],[180,"Still working — research-style skills can take 5–8 minutes…"]];
    function tick(){
      var s=Math.floor((Date.now()-start)/1000),m=Math.floor(s/60),ss=s%60;
      document.getElementById("el").textContent=m+":"+(ss<10?"0":"")+ss;
      var msg=stages[0][1];
      for(var i=0;i<stages.length;i++){if(s>=stages[i][0])msg=stages[i][1];}
      document.getElementById("st").textContent=msg;
    }
    tick();setInterval(tick,1000);
  </script>
</body></html>`;
}

/**
 * Terminal "stopped" body written on Stop so the iframe shows a clean stopped state
 * (no spinner, no stale error banner) and a re-open renders the true terminal state.
 */
export function stoppedBody(skill = ""): string {
  const label = (skill || "session").replace(/[<>&"]/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_top"><title>stopped</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
background:#0a0a0f;color:#d4d4d8;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{text-align:center}.icon{font-size:2rem;color:#f87171}.msg{margin-top:.5rem;color:#a1a1aa}</style></head>
<body><div class="card"><div class="icon">■</div><div class="msg">${label} — stopped</div></div></body></html>`;
}

/**
 * "Working" interstitial shown after submitting an answer-back form.
 * Displays submitted fields as a readonly summary + elapsed timer.
 * The SSE stream will trigger an iframe reload when body.html advances.
 */
export function workingPage(fields: Record<string, string> = {}): string {
  const fieldRows = Object.entries(fields)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`)
    .join("");
  const summaryBlock = fieldRows
    ? `<table style="border-collapse:collapse;margin:1rem 0;font:14px system-ui">${fieldRows}</table>`
    : "";
  return `<!doctype html><title>working…</title>
<style>
body{font:16px system-ui;padding:2rem;color:#9ca3af;background:#0a0f1a}
h3{color:#e2e8f0;margin:0 0 .5rem}
th{text-align:right;padding:3px 12px 3px 0;color:#64748b;font-weight:500;font-size:13px;vertical-align:top}
td{color:#94a3b8;font-size:13px;white-space:pre-wrap;max-width:32rem}
#timer{font-size:14px;margin-top:1rem;color:#64748b}
#slow{display:none;margin-top:.5rem;font-size:13px;color:#f59e0b}
</style>
<h3>received — working…</h3>
${summaryBlock}
<div id="timer">elapsed: <span id="t">0</span>s</div>
<div id="slow">still working — CC turns can take 1–3 min</div>
<script>
var s=0,iv=setInterval(function(){
  s++;document.getElementById('t').textContent=s;
  if(s>60)document.getElementById('slow').style.display='block';
},1000);
</script>`;
}

/** Map SessionStatus to a CSS class for the status dot (VOS-208: 6-state model). */
function dotClass(status: SessionStatus): string {
  if (status === "error") return "err";
  if (status === "awaiting") return "await";
  if (status === "reaped") return "reaped";
  if (status === "stopped") return "stopped";
  return ""; // working + complete = default green
}

/** CSS for the left nav sidebar — inlined alongside the shared UI_TOKENS block. */
const LEFT_NAV_CSS = `
/* Left nav sidebar */
.layout{display:flex;min-height:100vh}
.left-nav{width:200px;flex-shrink:0;background:hsl(217.2 32.6% 6%);border-right:1px solid hsl(var(--border));display:flex;flex-direction:column;gap:1px;padding:.5rem 0;overflow-y:auto;position:fixed;top:0;left:0;height:100vh;z-index:5}
.main-content{margin-left:200px;flex:1;min-width:0}
.nav-home{display:block;font-size:12px;font-weight:600;padding:.4rem .75rem;text-decoration:none;color:hsl(var(--muted-foreground));transition:color .15s,background .15s;border-radius:calc(var(--radius) - 4px);margin:0 .25rem}
.nav-home:hover,.nav-home.active{color:hsl(var(--foreground));background:hsl(var(--secondary))}
.nav-group-label{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:hsl(var(--muted-foreground));padding:.5rem .75rem .25rem;opacity:.6}
.nav-attention,.nav-recent{padding:0 .25rem}
.nav-session{display:flex;flex-direction:column;padding:.3rem .5rem;text-decoration:none;color:hsl(var(--foreground));border-radius:calc(var(--radius) - 4px);transition:background .1s;font-size:12px;overflow:hidden}
.nav-session:hover,.nav-session.active{background:hsl(var(--secondary))}
.nav-session.unseen{border-left:2px solid hsl(38 92% 50%);padding-left:.375rem}
.nav-session-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}
.nav-elapsed{font-size:10px;color:hsl(var(--muted-foreground));font-variant-numeric:tabular-nums}
`;

/** Client-side script that ticks elapsed-time spans (data-epoch attribute). */
const ELAPSED_TICK_SCRIPT = `<script>
(function(){
  function fmtElapsed(ms){
    var s=Math.floor(ms/1000);
    if(s<60)return s+'s';
    var m=Math.floor(s/60);
    if(m<60)return m+'m';
    var h=Math.floor(m/60);
    return h+'h '+(m%60)+'m';
  }
  function tickElapsed(){
    var now=Date.now();
    document.querySelectorAll('.nav-elapsed[data-epoch]').forEach(function(el){
      var epoch=parseInt(el.getAttribute('data-epoch'),10);
      if(epoch>0)el.textContent=fmtElapsed(now-epoch)+' ago';
    });
  }
  tickElapsed();
  setInterval(tickElapsed,10000);
})();
</script>`;

/**
 * Render the persistent left-nav sidebar fragment.
 * @param sessions Recent sessions (sorted newest-first from listSessions).
 * @param activeUuid The currently-displayed session uuid (marks it active), or undefined for dashboard.
 */
function leftNav(sessions: SessionInfo[], activeUuid?: string): string {
  const MAX_RECENT = 8;
  const attention = sessions.filter((s) => s.needsAttention);
  const recent = sessions.slice(0, MAX_RECENT);

  const btn = (s: SessionInfo) => {
    const active = s.uuid === activeUuid ? " active" : "";
    const unseen = s.needsAttention ? " unseen" : "";
    const epoch = s.lastActivityMs ?? s.mtimeMs;
    const shortTitle = esc(s.title.length > 22 ? s.title.slice(0, 22) + "…" : s.title);
    return `<a href="/s/${esc(s.uuid)}" class="nav-session${active}${unseen}"><span class="nav-session-title">${shortTitle}</span><span class="nav-elapsed" data-epoch="${epoch}"></span></a>`;
  };

  const attentionGroup = attention.length > 0
    ? `<div class="nav-attention"><div class="nav-group-label">needs attention</div>${attention.map(btn).join("")}</div>`
    : "";
  return `
<nav class="left-nav">
  <a href="/" class="nav-home${activeUuid ? "" : " active"}">⌂ home</a>
  ${attentionGroup}
  <div class="nav-recent"><div class="nav-group-label">recent</div>${recent.map(btn).join("")}</div>
</nav>`
}

/**
 * Main dashboard: skill launch chips + session list + relay auth banner.
 * Option 1 — Compact Command-Center style.
 */
export function renderDashboard(
  skills: { name: string; description: string; inputLabel?: string }[],
  sessions: SessionInfo[],
  relay: { authed: boolean },
  runnerCfg: { runners: Runner[]; defaultRunner: string } = { runners: DEFAULT_RUNNERS, defaultRunner: DEFAULT_RUNNER_LABEL },
  pendingDecisions: Decision[] = [],
): string {
  const showSelector = runnerCfg.runners.length > 1;
  const runnerOptions = runnerCfg.runners
    .map((r) => `<option value="${esc(r.label)}"${r.label === runnerCfg.defaultRunner ? " selected" : ""}>${esc(r.label)}</option>`)
    .join("");
  const runnerBar = showSelector
    ? `<div class="runner-bar"><label class="section-label">Run as</label>
     <select id="runner-select" onchange="syncRunner(this.value)">${runnerOptions}</select></div>`
    : "";
  const runnerScript = showSelector
    ? `<script>function syncRunner(v){document.getElementById('lm-runner').value=v;}</script>`
    : "";

  const skillChips = skills
    .map((s) => `
    <button type="button" class="skill-chip" data-skill="${esc(s.name)}"
      data-desc="${esc(s.description)}" data-placeholder="${esc(s.inputLabel || "optional input…")}"
      onclick="openLaunch(this)">${esc(s.name)}</button>`)
    .join("");

  const modal = `
<div id="launch-modal" class="modal-backdrop" hidden>
  <form action="/launch" method="POST" class="modal-card">
    <h2 id="lm-name"></h2>
    <p id="lm-desc" class="modal-desc"></p>
    <input type="hidden" name="skill" id="lm-skill" value="">
    <input type="hidden" name="runner" id="lm-runner" value="${esc(runnerCfg.defaultRunner)}">
    <textarea name="text" id="lm-text" class="modal-text" rows="3" placeholder=""></textarea>
    <div class="modal-actions">
      <button type="button" class="modal-cancel" onclick="closeLaunch()">Cancel</button>
      <button type="submit" class="modal-launch">Launch</button>
    </div>
  </form>
</div>`;

  const modalScript = `<script>
function openLaunch(btn){
  document.getElementById('lm-name').textContent=btn.dataset.skill;
  document.getElementById('lm-desc').textContent=btn.dataset.desc;
  document.getElementById('lm-skill').value=btn.dataset.skill;
  var t=document.getElementById('lm-text');t.value='';t.placeholder=btn.dataset.placeholder;
  document.getElementById('launch-modal').hidden=false;t.focus();
}
function closeLaunch(){document.getElementById('launch-modal').hidden=true;}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeLaunch();});
document.getElementById('launch-modal').addEventListener('click',function(e){if(e.target===this)closeLaunch();});
document.getElementById('lm-text').addEventListener('keydown',function(e){
  if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();this.closest('form').submit();}
});
</script>`;

  // Agent inbox: sessions awaiting a human verdict (skill rendered a <form> into body.html)
  const awaitingRows = sessions
    .filter((s) => s.status === "awaiting")
    .map(
      (s) => `
    <a href="/s/${esc(s.uuid)}" class="session-row">
      <span class="session-dot await"></span>
      <span class="session-title">${esc(s.title)}</span>
      <span class="session-uuid">${esc(s.uuid.slice(0, 8))}… — awaiting verdict</span>
    </a>`,
    )
    .join("");

  const rows = sessions
    .map(
      (s) => {
        const epoch = (s as any).lastActivityMs ?? s.mtimeMs;
        return `
    <a href="/s/${esc(s.uuid)}" class="session-row">
      <span class="session-dot${dotClass(s.status) ? ` ${dotClass(s.status)}` : ""}"></span>
      <span class="session-title">${esc(s.title)}</span>
      <span class="session-uuid">${esc(s.uuid.slice(0, 8))}… <span class="nav-elapsed" data-epoch="${epoch}"></span></span>
    </a>`;
      },
    )
    .join("");

  const badge = relay.authed
    ? `<span class="badge ok">relay ✓</span>`
    : `<span class="badge bad">relay ✗ — run <code>vc login</code></span>`;

  return `<!doctype html><meta charset=utf8><title>void-os</title>
<style>
${UI_TOKENS}
${LEFT_NAV_CSS}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  background:hsl(var(--background));color:hsl(var(--foreground));min-height:100vh}
code{font-family:monospace;font-size:0.85em}
/* Topbar */
.topbar{display:flex;align-items:center;gap:.75rem;padding:.5rem 1rem;
  border-bottom:1px solid hsl(var(--border));background:hsl(217.2 32.6% 8%)}
.logo{font-size:15px;font-weight:700;letter-spacing:-0.02em;color:hsl(var(--foreground))}
.badge{font-size:11px;padding:2px 7px;border-radius:9999px;font-weight:500}
.badge.ok{background:hsl(142 70% 12%);color:hsl(142 70% 65%)}
.badge.bad{background:hsl(0 62.8% 18%);color:hsl(0 70% 65%)}
/* Main layout (with left nav) */
.dash-layout{max-width:48rem;margin:0 auto;padding:1.25rem 1rem}
/* Section labels */
.section-label{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
  color:hsl(var(--muted-foreground));margin-bottom:.5rem}
/* Runner bar */
.runner-bar{display:flex;align-items:center;gap:.5rem;margin-bottom:1rem}
.runner-bar select{font:13px system-ui;background:hsl(var(--secondary));color:hsl(var(--foreground));
  border:1px solid hsl(var(--border));border-radius:calc(var(--radius) - 2px);padding:.2rem .5rem}
/* Skill chips */
.skill-chips{display:flex;flex-wrap:wrap;gap:.375rem;margin-bottom:1.5rem}
.skill-chip{display:inline-flex;align-items:center;gap:.375rem;padding:.3rem .75rem;
  border-radius:calc(var(--radius) - 2px);border:1px solid hsl(var(--border));
  background:hsl(var(--secondary));cursor:pointer;font-size:13px;font-weight:500;
  color:hsl(var(--secondary-foreground));transition:border-color .15s,background .15s}
.skill-chip:hover{border-color:hsl(var(--ring));background:hsl(var(--accent))}
/* Universal launch modal */
.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:50}
.modal-backdrop[hidden]{display:none}
.modal-card{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:var(--radius);padding:1.25rem;max-width:32rem;width:90%;color:hsl(var(--foreground))}
.modal-card h2{font-size:15px;margin-bottom:.4rem}
.modal-desc{font-size:13px;color:hsl(var(--muted-foreground));margin-bottom:.75rem;white-space:pre-wrap}
.modal-text{width:100%;background:hsl(var(--secondary));color:hsl(var(--foreground));border:1px solid hsl(var(--border));border-radius:calc(var(--radius) - 2px);padding:.5rem;font:13px system-ui;resize:vertical}
.modal-actions{display:flex;justify-content:flex-end;gap:.5rem;margin-top:.75rem}
.modal-cancel,.modal-launch{font-size:13px;padding:.35rem .85rem;border-radius:calc(var(--radius) - 2px);cursor:pointer;border:1px solid hsl(var(--border))}
.modal-cancel{background:transparent;color:hsl(var(--muted-foreground))}
.modal-launch{background:hsl(var(--primary));color:hsl(var(--primary-foreground));border-color:hsl(var(--ring))}
/* Session list */
.session-list{display:flex;flex-direction:column;gap:1px}
.session-row{display:flex;align-items:center;gap:.75rem;padding:.5rem .625rem;
  border-radius:calc(var(--radius) - 2px);text-decoration:none;color:hsl(var(--foreground));
  transition:background .1s}
.session-row:hover{background:hsl(var(--secondary))}
.session-dot{width:6px;height:6px;border-radius:50%;background:hsl(142 70% 45%);flex-shrink:0}
.session-dot.err{background:hsl(0 70% 55%)}
.session-dot.await{background:hsl(38 92% 50%)}
.session-dot.reaped{background:hsl(217 10% 45%)}
.session-dot.stopped{background:hsl(0 0% 40%)}
.session-title{flex:1;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.session-uuid{font-size:11px;font-family:monospace;color:hsl(var(--muted-foreground))}
</style>
<div class="topbar"><span class="logo">void-os</span>${badge}</div>
<div class="layout">
${leftNav(sessions)}
<div class="main-content">
<div class="dash-layout">
${pendingDecisions.length === 0 ? "" : `
<div class="section-label" style="color:hsl(38 92% 65%)">Pending decisions</div>
<div class="session-list" style="margin-bottom:1.25rem">${pendingDecisions.map((d) => `
  <div class="session-row" data-decision-id="${esc(d.id)}" style="flex-direction:column;align-items:flex-start;gap:.25rem;border:1px solid hsl(38 92% 25%);border-radius:calc(var(--radius) - 2px);padding:.625rem">
    <div><code style="font-size:11px;color:hsl(var(--muted-foreground))">${esc(d.id)}</code></div>
    <div style="font-size:13px;font-weight:500">${esc(d.question)}</div>
    ${d.options.length ? `<div style="font-size:12px;color:hsl(var(--muted-foreground))">options: ${esc(d.options.join(" / "))}</div>` : ""}
    ${d.context ? `<div style="font-size:12px;color:hsl(var(--muted-foreground))">${esc(d.context)}</div>` : ""}
    <div style="font-size:11px;color:hsl(var(--muted-foreground));font-family:monospace">reply via bus: kind=decision-reply, routing.decisionRef=${esc(d.id)}</div>
  </div>`).join("")}
</div>`}
${runnerBar}
<div class="section-label">Skills</div>
<div class="skill-chips">${skillChips}</div>
<div class="section-label">Agent inbox — pending verdicts</div>
<div class="session-list">${awaitingRows || '<span style="font-size:13px;color:hsl(var(--muted-foreground));padding:.5rem .625rem">no pending verdicts</span>'}</div>
<div class="section-label" style="margin-top:1.25rem">Sessions</div>
<div class="session-list">${rows || '<span style="font-size:13px;color:hsl(var(--muted-foreground));padding:.5rem .625rem">no sessions yet</span>'}</div>
${modal}
</div>
</div>
</div>
${runnerScript}
${modalScript}
${ELAPSED_TICK_SCRIPT}`;
}

/**
 * Iframe shell: wraps a session's body.html in a 36px header with back link,
 * session name, and click-to-copy resume command. Option 1 style.
 * @param name Human-readable session name (e.g. skill name). Falls back to short uuid.
 */
export function renderShell(uuid: string, vault: string, name?: string, attachCmd?: string, interactive?: boolean, sessions: SessionInfo[] = []): string {
  // The resume command must be run from the vault dir because CC uses cwd to locate sessions.
  const resumeCmd = attachCmd ?? `cd ${vault} && vc -- --resume ${uuid}`;
  // Truncated display label for the copy-button (max ~40 chars from end)
  const shortVault = vault.length > 20 ? "…" + vault.slice(-18) : vault;
  const displayLabel = `${shortVault} — resume ${uuid.slice(0, 8)}…`;

  // Header title: show the human-readable session name when available; fall back to short uuid.
  const headerName = name ? name : uuid.slice(0, 8) + "…";

  // Store cmd/label in data attributes to avoid inline-JS quoting issues
  const resumeCmdAttr = esc(resumeCmd);
  const displayLabelAttr = esc(displayLabel);

  return `<!doctype html><meta charset=utf8><title>session ${esc(uuid)}</title>
<style>
${UI_TOKENS}
${LEFT_NAV_CSS}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  background:hsl(var(--background));color:hsl(var(--foreground))}
.shell-header{display:flex;align-items:center;gap:.75rem;padding:.4rem .75rem;
  background:hsl(217.2 32.6% 8%);border-bottom:1px solid hsl(var(--border));min-height:36px}
.back-link{display:flex;align-items:center;gap:.25rem;font-size:12px;
  color:hsl(var(--muted-foreground));text-decoration:none;padding:2px 6px;
  border-radius:calc(var(--radius) - 4px);transition:color .15s,background .15s;flex-shrink:0}
.back-link:hover{color:hsl(var(--foreground));background:hsl(var(--secondary))}
.divider-v{width:1px;height:16px;background:hsl(var(--border))}
.session-name{flex:1;font-size:12px;font-weight:500;color:hsl(var(--muted-foreground));
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.copy-btn{display:inline-flex;align-items:center;gap:.3rem;font-family:monospace;font-size:11px;
  padding:3px 8px;border-radius:calc(var(--radius) - 4px);border:1px solid hsl(var(--border));
  background:hsl(var(--secondary));color:hsl(var(--muted-foreground));cursor:pointer;
  flex-shrink:0;transition:border-color .15s,color .15s;max-width:22rem;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;user-select:none}
.copy-btn:hover{border-color:hsl(var(--ring));color:hsl(var(--foreground))}
.copy-btn.copied{border-color:hsl(142 70% 45%);color:hsl(142 70% 65%);background:hsl(142 70% 8%)}
.stop-btn{font-size:11px;padding:2px 8px;border:1px solid hsl(0 60% 40%);background:transparent;
  color:hsl(0 70% 65%);border-radius:calc(var(--radius) - 4px);cursor:pointer;flex-shrink:0}
.stop-btn:hover{background:hsl(0 60% 12%)}
.attach-btn{font-size:11px;padding:2px 8px;border:1px solid hsl(142 60% 30%);background:transparent;
  color:hsl(142 70% 65%);border-radius:calc(var(--radius) - 4px);cursor:pointer;flex-shrink:0}
.attach-btn:hover{background:hsl(142 60% 8%)}
.msg-form{display:flex;gap:.3rem;flex-shrink:0}
.msg-input{font-size:11px;padding:2px 6px;border:1px solid hsl(var(--border));background:hsl(var(--secondary));
  color:hsl(var(--foreground));border-radius:calc(var(--radius) - 4px);width:12rem}
.msg-send{font-size:11px;padding:2px 8px;border:1px solid hsl(217 60% 40%);background:transparent;
  color:hsl(217 70% 65%);border-radius:calc(var(--radius) - 4px);cursor:pointer;flex-shrink:0}
.msg-send:hover{background:hsl(217 60% 8%)}
iframe{border:0;width:100%;height:calc(100vh - 36px);display:block}
body.drawer-open iframe{height:calc(100vh - 36px - 40vh - 28px)}
/* Shell main content offset for left nav */
.shell-main{margin-left:200px;display:flex;flex-direction:column}
.shell-header{margin-left:0}
#drawer-bar{position:fixed;left:200px;right:0;bottom:0;height:28px;z-index:10;
  display:flex;align-items:center;padding:0 .75rem;cursor:pointer;user-select:none;
  font-size:11px;font-family:monospace;color:hsl(var(--muted-foreground));
  background:hsl(217.2 32.6% 8%);border-top:1px solid hsl(var(--border))}
#drawer-bar:hover{color:hsl(var(--foreground))}
body.drawer-open #drawer-bar{bottom:40vh}
#drawer-panel{position:fixed;left:200px;right:0;bottom:0;height:40vh;z-index:9;display:none;
  overflow:auto;padding:.5rem .75rem;background:hsl(var(--background));
  border-top:1px solid hsl(var(--border));font-size:12px;line-height:1.5}
body.drawer-open #drawer-panel{display:block}
.turn{white-space:pre-wrap;word-break:break-word;padding:.35rem 0;
  border-bottom:1px solid hsl(var(--border))}
.turn .who{display:block;font-family:monospace;font-size:10px;text-transform:uppercase;
  letter-spacing:.04em;color:hsl(var(--muted-foreground));margin-bottom:.15rem}
.role-user .who{color:hsl(217 70% 65%)}
.role-assistant .who{color:hsl(142 60% 60%)}
</style>
${leftNav(sessions, uuid)}
<div class="shell-main">
<div class="shell-header">
  <a href="/" class="back-link">← all</a>
  <span class="divider-v"></span>
  <span class="session-name">${esc(headerName)}</span>
  <button class="copy-btn" id="copybtn" title="Copy resume command"
    data-cmd="${resumeCmdAttr}" data-label="${displayLabelAttr}">${displayLabelAttr}</button>
  <form action="/s/${esc(uuid)}/stop" method="POST" class="stop-form" style="flex-shrink:0">
    <button type="submit" class="stop-btn" title="Stop this session">■ Stop</button>
  </form>
  <form id="attachForm" action="/s/${esc(uuid)}/attach-here" method="POST" class="stop-form" style="flex-shrink:0">
    <button type="submit" class="attach-btn" title="Attach terminal to this session">⤵ Attach here</button>
  </form>
  <form id="msgForm" action="/s/${esc(uuid)}/message" method="POST" class="msg-form">
    <input type="text" name="text" class="msg-input" placeholder="Send message…">
    <button type="submit" class="msg-send" title="Send message to session">Send</button>
  </form>
</div>
<iframe id="f" src="/s/${esc(uuid)}/body"></iframe>
</div>
<div id="drawer-panel"></div>
<div id="drawer-bar">▾ transcript</div>
<script>
document.getElementById('copybtn').addEventListener('click',function(){
  var b=this,cmd=b.getAttribute('data-cmd'),lbl=b.getAttribute('data-label');
  navigator.clipboard&&navigator.clipboard.writeText(cmd);
  b.textContent='✓ copied';b.classList.add('copied');
  setTimeout(function(){b.textContent=lbl;b.classList.remove('copied')},1800);
});
// Intercept attach + message forms with fetch() so the browser stays on the dashboard.
// Native form POST navigates to the JSON response; fetch() stays put.
['attachForm','msgForm'].forEach(function(id){
  var fm=document.getElementById(id);
  if(!fm) return;
  fm.addEventListener('submit',function(e){
    e.preventDefault();
    fetch(fm.getAttribute('action'),{method:'POST',body:new FormData(fm)})
      .then(function(r){return r.json();}).catch(function(){});
    var inp=fm.querySelector('.msg-input'); if(inp) inp.value='';
  });
});
var msgInput=document.querySelector('.msg-input');
if(msgInput){
  msgInput.addEventListener('keydown',function(e){
    if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();this.closest('form').requestSubmit();}
  });
}
var es=new EventSource("/s/${esc(uuid)}/stream");
// Always navigate to the canonical body URL on reload events rather than re-POST.
// location.reload() would re-submit POST /send and spawn a spurious vc turn.
// After reload, probe the session status; close the EventSource once terminal so
// the spinner stops and the connection is not held open needlessly.
es.onmessage=function(){
  var f=document.getElementById("f");
  f.contentWindow.location.replace("/s/${esc(uuid)}/body");
  fetch("/s/${esc(uuid)}/status").then(function(r){return r.text();}).then(function(s){
    if(s==="stopped"||s==="error"||s==="complete"||s==="reaped"){es.close();}
  });
};
var dvBar=document.getElementById("drawer-bar");
var dvPanel=document.getElementById("drawer-panel");
var dvTimer=null;
function dvNearBottom(){return dvPanel.scrollTop+dvPanel.clientHeight>=dvPanel.scrollHeight-40;}
function dvRefresh(){
  fetch("/s/${esc(uuid)}/transcript").then(function(r){return r.text();}).then(function(html){
    var atBottom=dvNearBottom();
    dvPanel.innerHTML=html;
    if(atBottom){dvPanel.scrollTop=dvPanel.scrollHeight;}
  });
}
dvBar.addEventListener("click",function(){
  var open=document.body.classList.toggle("drawer-open");
  dvBar.textContent=open?"▴ transcript":"▾ transcript";
  if(open){dvRefresh();dvTimer=setInterval(dvRefresh,2000);}
  else if(dvTimer){clearInterval(dvTimer);dvTimer=null;}
});
</script>
${ELAPSED_TICK_SCRIPT}`;
}

/**
 * Render a chat thread transcript + its cold-context budget readout.
 * Read-only view: chat input goes via the bus, not a form (ADR-0003 §6).
 */
export function renderChatThread(t: {
  thread: string;
  transcript: string;
  cold: { bytes: number; tokenEstimate: number };
}): string {
  const body = esc(t.transcript).replace(/\n/g, "<br>");
  return `<section class="chat-thread">
  <h2>chat: ${esc(t.thread)}</h2>
  <div class="cold-context">cold-context: ${t.cold.bytes} bytes · ~${t.cold.tokenEstimate} tokens</div>
  <div class="transcript">${body}</div>
</section>`;
}
