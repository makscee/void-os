// render.ts — HTML string templates for dashboard, iframe shell, placeholder, working page (Task 9)
import type { CatalogSkill } from "./catalog.ts";
import type { SessionInfo, SessionStatus } from "./sessions.ts";
import { DEFAULT_RUNNERS, DEFAULT_RUNNER_LABEL } from "./paths.ts";
import type { Runner } from "./paths.ts";

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

/** Map SessionStatus to a CSS class for the status dot. */
function dotClass(status: SessionStatus): string {
  if (status === "error") return "err";
  if (status === "awaiting") return "await";
  return ""; // complete = default green
}

/**
 * Main dashboard: skill launch chips + session list + relay auth banner.
 * Option 1 — Compact Command-Center style.
 */
export function renderDashboard(
  skills: CatalogSkill[],
  sessions: SessionInfo[],
  relay: { authed: boolean },
  runnerCfg: { runners: Runner[]; defaultRunner: string } = { runners: DEFAULT_RUNNERS, defaultRunner: DEFAULT_RUNNER_LABEL },
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
    ? `<script>function syncRunner(v){document.querySelectorAll('input[name=runner]').forEach(function(i){i.value=v})}</script>`
    : "";

  const skillChips = skills
    .map(
      (s) => `
    <form action="/launch" method="POST" class="skill-chip-form">
      <input type="hidden" name="skill" value="${esc(s.name)}">
      <input type="hidden" name="runner" value="${esc(runnerCfg.defaultRunner)}">
      <button type="submit" class="skill-chip">
        <span>${esc(s.name)}</span>
        <input name="text" placeholder="optional input…" onclick="event.stopPropagation()">
      </button>
    </form>`,
    )
    .join("");

  const rows = sessions
    .map(
      (s) => `
    <a href="/s/${esc(s.uuid)}" class="session-row">
      <span class="session-dot${s.status === "error" ? " err" : s.status === "awaiting" ? " await" : ""}"></span>
      <span class="session-title">${esc(s.title)}</span>
      <span class="session-uuid">${esc(s.uuid.slice(0, 8))}…</span>
    </a>`,
    )
    .join("");

  const badge = relay.authed
    ? `<span class="badge ok">relay ✓</span>`
    : `<span class="badge bad">relay ✗ — run <code>vc login</code></span>`;

  return `<!doctype html><meta charset=utf8><title>void-os</title>
<style>
${UI_TOKENS}
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
/* Main layout */
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
.skill-chip-form{display:inline-flex}
.skill-chip{display:inline-flex;align-items:center;gap:.375rem;padding:.3rem .75rem;
  border-radius:calc(var(--radius) - 2px);border:1px solid hsl(var(--border));
  background:hsl(var(--secondary));cursor:pointer;font-size:13px;font-weight:500;
  color:hsl(var(--secondary-foreground));transition:border-color .15s,background .15s}
.skill-chip:hover{border-color:hsl(var(--ring));background:hsl(var(--accent))}
.skill-chip input{width:0;overflow:hidden;padding:0;border:none;background:transparent;
  transition:width .2s;font:inherit;color:inherit;outline:none}
.skill-chip:focus-within{border-color:hsl(var(--ring))}
.skill-chip:focus-within input{width:9rem;padding-left:.375rem;
  border-left:1px solid hsl(var(--border));margin-left:.375rem}
/* Session list */
.session-list{display:flex;flex-direction:column;gap:1px}
.session-row{display:flex;align-items:center;gap:.75rem;padding:.5rem .625rem;
  border-radius:calc(var(--radius) - 2px);text-decoration:none;color:hsl(var(--foreground));
  transition:background .1s}
.session-row:hover{background:hsl(var(--secondary))}
.session-dot{width:6px;height:6px;border-radius:50%;background:hsl(142 70% 45%);flex-shrink:0}
.session-dot.err{background:hsl(0 70% 55%)}
.session-dot.await{background:hsl(38 92% 50%)}
.session-title{flex:1;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.session-uuid{font-size:11px;font-family:monospace;color:hsl(var(--muted-foreground))}
</style>
${runnerScript}
<div class="topbar"><span class="logo">void-os</span>${badge}</div>
<div class="dash-layout">
${runnerBar}
<div class="section-label">Skills</div>
<div class="skill-chips">${skillChips}</div>
<div class="section-label">Sessions</div>
<div class="session-list">${rows || '<span style="font-size:13px;color:hsl(var(--muted-foreground));padding:.5rem .625rem">no sessions yet</span>'}</div>
</div>`;
}

/**
 * Iframe shell: wraps a session's body.html in a 36px header with back link,
 * session name, and click-to-copy resume command. Option 1 style.
 */
export function renderShell(uuid: string, vault: string): string {
  // The resume command must be run from the vault dir because CC uses cwd to locate sessions.
  const resumeCmd = `cd ${vault} && vc -- --resume ${uuid}`;
  const resumeCmdEsc = esc(resumeCmd);
  // Truncated display label for the button (max ~40 chars from end)
  const shortVault = vault.length > 20 ? "…" + vault.slice(-18) : vault;
  const displayLabel = `${shortVault} — resume ${uuid.slice(0, 8)}…`;
  const displayLabelEsc = esc(displayLabel);

  // Store cmd/label in data attributes to avoid inline-JS quoting issues
  const resumeCmdAttr = esc(resumeCmd);
  const displayLabelAttr = esc(displayLabel);

  return `<!doctype html><meta charset=utf8><title>session ${esc(uuid)}</title>
<style>
${UI_TOKENS}
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
iframe{border:0;width:100%;height:calc(100vh - 36px);display:block}
body.drawer-open iframe{height:calc(100vh - 36px - 40vh - 28px)}
#drawer-bar{position:fixed;left:0;right:0;bottom:0;height:28px;z-index:10;
  display:flex;align-items:center;padding:0 .75rem;cursor:pointer;user-select:none;
  font-size:11px;font-family:monospace;color:hsl(var(--muted-foreground));
  background:hsl(217.2 32.6% 8%);border-top:1px solid hsl(var(--border))}
#drawer-bar:hover{color:hsl(var(--foreground))}
body.drawer-open #drawer-bar{bottom:40vh}
#drawer-panel{position:fixed;left:0;right:0;bottom:0;height:40vh;z-index:9;display:none;
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
<div class="shell-header">
  <a href="/" class="back-link">← all</a>
  <span class="divider-v"></span>
  <span class="session-name">${esc(uuid)}</span>
  <button class="copy-btn" id="copybtn" title="Copy resume command"
    data-cmd="${resumeCmdAttr}" data-label="${displayLabelAttr}">${displayLabelAttr}</button>
</div>
<iframe id="f" src="/s/${esc(uuid)}/body"></iframe>
<div id="drawer-panel"></div>
<div id="drawer-bar">▾ transcript</div>
<script>
document.getElementById('copybtn').addEventListener('click',function(){
  var b=this,cmd=b.getAttribute('data-cmd'),lbl=b.getAttribute('data-label');
  navigator.clipboard&&navigator.clipboard.writeText(cmd);
  b.textContent='✓ copied';b.classList.add('copied');
  setTimeout(function(){b.textContent=lbl;b.classList.remove('copied')},1800);
});
var es=new EventSource("/s/${esc(uuid)}/stream");
// Always navigate to the canonical body URL on reload events rather than re-POST.
// location.reload() would re-submit POST /send and spawn a spurious vc turn.
es.onmessage=function(){document.getElementById("f").contentWindow.location.replace("/s/${esc(uuid)}/body")};
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
</script>`;
}
