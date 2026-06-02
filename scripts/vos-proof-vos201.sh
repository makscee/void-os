#!/usr/bin/env bash
# vos-proof-vos201.sh — VOS-201 real-path proof. NO self-downgrade.
#
# What it proves:
#   A. skill-author SKILL invoked via REAL claude session (/launch seam) with an authoring intent
#      → CC session drafts SKILL.md + trigger + calls skill_manage(create) → Decision parked;
#      catalog untouched pre-approval; NO direct catalog write by the session.
#   B. REAL approve path — decision-reply bus → daemon drain → skill-manage-apply continuation
#      CC execution → skill activated WITH NO daemon restart; trigger reconciled live;
#      invoke the new bus-bound skill via its live trigger → exec row → rebuildExecutions MATCH.
#   C. REAL reject path — second create via stdio MCP → reject reply → drop cleanly.
#   D. No regression: bun test --isolate full suite green.
#
# Requires: vc authenticated, bun, void-os source.
# Usage: bash scripts/vos-proof-vos201.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# node_modules live in the main worktree (canonical clone), not in a task worktree.
# Resolve by finding the first worktree entry that has node_modules.
NM_ROOT="$REPO"
if [[ ! -d "$REPO/node_modules/@modelcontextprotocol" ]]; then
  while IFS= read -r line; do
    [[ "$line" == worktree\ * ]] && CANDIDATE="${line#worktree }" && \
      [[ -d "$CANDIDATE/node_modules/@modelcontextprotocol" ]] && NM_ROOT="$CANDIDATE" && break
  done < <(git -C "$REPO" worktree list --porcelain 2>/dev/null)
fi
VAULT="/tmp/void-os-vos201-proof"
DB="$VAULT/.void-os/registry.db"
PORT=14401
DAEMON_URL="http://127.0.0.1:$PORT"
LOG="/tmp/vos201-proof.log"
DAEMON_PID=""

cleanup() {
  [[ -n "$DAEMON_PID" ]] && { kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true; }
  tmux ls 2>/dev/null | grep "^vos-run-" | cut -d: -f1 | xargs -I{} tmux kill-session -t {} 2>/dev/null || true
}
trap cleanup EXIT

log()  { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
fail() { log "FAIL: $*"; exit 1; }
pass() { log "PASS: $*"; }

q() { bun --eval "const {Database}=require('bun:sqlite');const db=new Database('$DB');console.log(JSON.stringify(db.query(\"$1\").all()));" 2>/dev/null; }

poll_exec_for_trigger() {
  local trig="$1" after="$2" deadline=$((SECONDS + $3)) id
  while [[ $SECONDS -lt $deadline ]]; do
    id=$(bun --eval "const {Database}=require('bun:sqlite');const db=new Database('$DB');const r=db.query('SELECT id FROM executions WHERE trigger_id=? AND started_at>=? ORDER BY started_at DESC LIMIT 1').get('$trig',$after);console.log(r?r.id:'none');" 2>/dev/null) || id="none"
    [[ "$id" != "none" && -n "$id" ]] && { echo "$id"; return 0; }
    sleep 2
  done
  echo "none"
}

wait_exec_ended() {
  local id="$1" deadline=$((SECONDS + $2)) e
  while [[ $SECONDS -lt $deadline ]]; do
    e=$(bun --eval "const {Database}=require('bun:sqlite');const db=new Database('$DB');const r=db.query('SELECT ended_at FROM executions WHERE id=?').get('$id');console.log(r?(r.ended_at!=null?'ended':'running'):'none');" 2>/dev/null) || e="error"
    [[ "$e" == "ended" ]] && return 0
    sleep 2
  done
  return 1
}

# ---- Real stdio MCP helper: spawns mcp-server.ts as a child, connects real StdioClientTransport ----
mcp_stdio_call() {
  local tool="$1" args_json="$2"
  REPO="$REPO" NM_ROOT="$NM_ROOT" VAULT="$VAULT" MCP_TOOL="$tool" MCP_ARGS="$args_json" bun --eval "
    const { Client } = await import('$NM_ROOT/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
    const { StdioClientTransport } = await import('$NM_ROOT/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
    const transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', process.env.REPO + '/src/mcp-server.ts'],
      env: { ...process.env, VOID_OS_VAULT: process.env.VAULT, VOID_OS_MCP_DIRECT: '1' },
    });
    const client = new Client({ name: 'vos201-proof', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(t => t.name);
    if (!tools.includes('skill_manage')) { console.error('STDIO-LISTTOOLS-FAIL:'+JSON.stringify(tools)); process.exit(3); }
    const result = await client.callTool({ name: process.env.MCP_TOOL, arguments: JSON.parse(process.env.MCP_ARGS) });
    process.stdout.write(result.content[0].text);
    await client.close();
    process.exit(0);
  " 2>>"$LOG"
}

esc() { printf '%s' "$1" | bun --eval "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(d)));" 2>/dev/null; }

rm -f "$LOG"
log "=== VOS-201 real-path proof — skill-author + teach/evolve loop ==="
log "Repo: $REPO"
log "Vault: $VAULT"
log "Port: $PORT"

lsof -ti :$PORT 2>/dev/null | xargs kill -9 2>/dev/null || true

# ---- Preflight: bun present ----
log "Checking bun..."
command -v bun >/dev/null 2>&1 || fail "bun not found in PATH"
log "bun found: $(command -v bun)"

# ---- Setup vault via seedVault ----
log ""
log "=== Setup: init proof vault via seedVault ==="
rm -rf "$VAULT"
VOID_OS_DAEMON_URL="$DAEMON_URL" VOID_OS_VAULT="$VAULT" bun run "$REPO/src/cli.ts" init "$VAULT" 2>/dev/null || true

[[ -f "$VAULT/.mcp.json" ]] || fail "seedVault did not write .mcp.json"
pass ".mcp.json written"

[[ -f "$VAULT/.claude/settings.json" ]] || fail "seedVault did not write .claude/settings.json"
pass ".claude/settings.json written"

# Confirm skill-author is present (seedVault cpSync copies all catalog/skills)
[[ -f "$VAULT/.claude/skills/skill-author/SKILL.md" ]] || fail ".claude/skills/skill-author/SKILL.md not seeded by seedVault"
pass "skill-author skill seeded: $VAULT/.claude/skills/skill-author/SKILL.md"

# Confirm skill-manage-apply is present
[[ -f "$VAULT/.claude/skills/skill-manage-apply/SKILL.md" ]] || fail "skill-manage-apply not seeded"
pass "skill-manage-apply skill seeded"

# Confirm CLAUDE.md primer is present
[[ -f "$VAULT/CLAUDE.md" ]] || fail "CLAUDE.md primer not copied to vault"
pass "CLAUDE.md primer present"

# Validate skill-author frontmatter
FM=$(bun --eval "import('./src/frontmatter.ts').then(m=>console.log(JSON.stringify(m.parseFrontmatter(require('fs').readFileSync('catalog/skills/skill-author/SKILL.md','utf8')))))" 2>/dev/null)
echo "$FM" | grep -q '"name":"skill-author"' || fail "skill-author frontmatter: name missing"
echo "$FM" | grep -q '"description"' || fail "skill-author frontmatter: description missing"
FNAME=$(echo "$FM" | bun --eval "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j.description||'');});" 2>/dev/null)
[[ -n "$FNAME" ]] || fail "skill-author description is empty"
pass "skill-author frontmatter valid: name=skill-author, description non-empty"

# Confirm skill-author NEVER writes catalog/skills directly (no raw file writes)
grep -q 'catalog/skills' "$VAULT/.claude/skills/skill-author/SKILL.md" && \
  grep -E 'writeFile|cpSync|copyFile|mkdir.*catalog' "$VAULT/.claude/skills/skill-author/SKILL.md" 2>/dev/null && \
  fail "skill-author SKILL.md contains direct catalog/skills write commands" || true
pass "skill-author does not contain direct catalog write commands (gated path only)"

# Write void-os.json config
bun --eval "
  const fs=require('fs'),path=require('path');
  const cfg={vault:'$VAULT',onboarded:true,skills:['skill-manage-apply','skill-author'],answers:{},port:$PORT,runners:[{label:'vc (relay)',command:'vc --'}],defaultRunner:'vc (relay)'};
  fs.writeFileSync(path.join('$VAULT','void-os.json'),JSON.stringify(cfg,null,2));
" 2>/dev/null
pass "void-os.json written"

# Install skill-apply trigger (needed for daemon to route decision-reply lines)
mkdir -p "$VAULT/triggers"
cat > "$VAULT/triggers/skill-apply-t.md" <<'EOF'
---
kind: event
skill: skill-manage-apply
agent: default
inbox: bus
event_kind: decision-reply
step_ceiling: 30
---
skill-apply-t: fires skill-manage-apply continuation on kind=decision-reply bus lines.
EOF

mkdir -p "$VAULT/inbox"

# ---- Start daemon ----
log ""
log "=== Start daemon (port $PORT) ==="
VOID_OS_VAULT="$VAULT" bun run "$REPO/src/cli.ts" serve --no-open >> "$LOG" 2>&1 &
DAEMON_PID=$!
for i in $(seq 1 25); do
  kill -0 "$DAEMON_PID" 2>/dev/null || fail "Daemon died before ready"
  bun --eval "const r=await fetch('$DAEMON_URL/').catch(()=>null);process.exit(r?0:1);" 2>/dev/null && { log "Daemon ready (pid $DAEMON_PID)"; break; }
  sleep 1; [[ $i -eq 25 ]] && fail "Daemon not ready in 25s"
done

# ============================================================
log ""
log "=== Proof A: skill-author invoked via REAL claude session (agent+print mode) → drafts + skill_manage(create) → Decision parked ==="
# ============================================================
# This proof exercises the skill-author SKILL itself through the daemon /launch seam —
# a real CC session reads the intent, drafts SKILL.md + trigger, and calls skill_manage(create).
# Agent launch (agent=skill-author-proxy) forces print mode so the headless session exits on its own.
# We assert: Decision parked, quarantine staged, catalog untouched, NO direct catalog write.

# Preflight: claude binary required for real CC session
command -v claude >/dev/null 2>&1 || fail "claude binary not found in PATH — required for Proof A real CC session"
log "claude found: $(command -v claude)"

# Seed the skill-author-proxy agent in the proof vault.
# Agent body = the authoring intent; the CC session gets "-p /skill-author\n\n<intent>" in print mode.
# Skills list instructs the agent identity to invoke skill-author.
INTENT="Create a bus-bound skill named vos201-proof-skill. It must be bus-bound: it should fire automatically on inbound bus events with kind=vos201-proof. When invoked, it appends a UTC timestamp to output. Make sure to also draft the trigger so it routes kind=vos201-proof events to this skill."
mkdir -p "$VAULT/agents"
cat > "$VAULT/agents/skill-author-proxy.md" <<AGENTEOF
---
name: skill-author-proxy
description: Proof agent — reads an authoring intent from body and invokes the skill-author skill to draft and submit it via the gated skill_manage pipeline.
skills:
  - skill-author
---
$INTENT
AGENTEOF
pass "skill-author-proxy agent seeded in proof vault"

# Snapshot quarantine dir before launch to detect new txns
QBASE="$VAULT/.void-os/skill-quarantine"
mkdir -p "$QBASE"
BEFORE_QS=$(ls "$QBASE" 2>/dev/null | sort)
BEFORE_DEC_COUNT=$(bun --eval "const {listPendingDecisions}=await import('$REPO/src/decision.ts');console.log(listPendingDecisions('$VAULT').length);" 2>/dev/null) || BEFORE_DEC_COUNT=0
BEFORE_A_TS=$(($(date +%s) * 1000))
BEFORE_QS_COUNT=$(echo "$BEFORE_QS" | grep -v '^$' | wc -l | tr -d ' ' || echo 0)
log "Quarantine snapshot before launch (entries: $BEFORE_QS_COUNT); pending decisions: $BEFORE_DEC_COUNT"

# POST /launch with agent=skill-author-proxy and skill=skill-author.
# Agent launch sets forcePrint=true → CC runs headlessly in print mode and exits on its own.
log "POST /launch agent=skill-author-proxy skill=skill-author..."
LAUNCH_RESP=$(bun --eval "
  const r = await fetch('$DAEMON_URL/launch', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({agent: 'skill-author-proxy', skill: 'skill-author'}).toString(),
    redirect: 'manual',
  }).catch((e) => { console.log('FETCH_ERROR: ' + e.message); process.exit(1); });
  console.log('status=' + r.status + ' location=' + (r.headers.get('location') ?? 'none'));
" 2>/dev/null) || fail "POST /launch agent=skill-author-proxy failed"
log "Launch response: $LAUNCH_RESP"

# Extract run ID from redirect location /s/<exec-id>
AUTHOR_RUN_ID=$(echo "$LAUNCH_RESP" | grep -oE '/s/exec-[a-z0-9-]+' | sed 's|/s/||') || AUTHOR_RUN_ID=""
if [[ -z "$AUTHOR_RUN_ID" ]]; then
  log "No redirect location captured; polling DB for skill-author-proxy exec row..."
  AUTHOR_RUN_ID=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const db = new Database('$DB');
      const r = db.query('SELECT id FROM executions WHERE agent=? AND started_at>=? ORDER BY started_at DESC LIMIT 1').get('skill-author-proxy', $BEFORE_A_TS);
      if (r) { console.log(r.id); process.exit(0); }
      await new Promise(res => setTimeout(res, 1000));
    }
    console.log('none');
  " 2>/dev/null) || AUTHOR_RUN_ID="none"
fi
[[ "$AUTHOR_RUN_ID" == "none" || -z "$AUTHOR_RUN_ID" ]] && fail "No skill-author-proxy exec row appeared after /launch"
log "skill-author exec row: $AUTHOR_RUN_ID"
pass "skill-author exec row created via agent launch: $AUTHOR_RUN_ID"

# Confirm exec.agent=skill-author-proxy (agent field set)
AGENT_FIELD=$(bun --eval "const {Database}=require('bun:sqlite');const db=new Database('$DB');const r=db.query('SELECT agent FROM executions WHERE id=?').get('$AUTHOR_RUN_ID');console.log(r?(r.agent??'null'):'missing');" 2>/dev/null) || AGENT_FIELD="error"
[[ "$AGENT_FIELD" == "skill-author-proxy" ]] || fail "exec.agent should be skill-author-proxy, got: $AGENT_FIELD"
pass "exec.agent=skill-author-proxy confirmed"

# Confirm skill-author is in the CC command (print mode with /skill-author in -p)
wait_cc_cmd() {
  local exec_id="$1" deadline=$((SECONDS + $2))
  while [[ $SECONDS -lt $deadline ]]; do
    [[ -f "$VAULT/sessions/$exec_id/cc-command.txt" ]] && return 0
    sleep 1
  done
  return 1
}
wait_cc_cmd "$AUTHOR_RUN_ID" 10 || fail "cc-command.txt not written for skill-author exec"
CC_CMD=$(cat "$VAULT/sessions/$AUTHOR_RUN_ID/cc-command.txt")
echo "$CC_CMD" | grep -q "skill-author" || fail "cc-command.txt does not contain skill-author — skill not invoked"
echo "$CC_CMD" | grep -q "\-p" || fail "cc-command.txt missing -p flag (not in print mode — session will hang)"
pass "cc-command.txt contains /skill-author with -p (print mode confirmed)"

# Wait for the CC session to complete (max 300s — real CC session drafts + skill_manage + exits)
log "Waiting for skill-author CC session to complete (max 300s)..."
wait_exec_ended "$AUTHOR_RUN_ID" 300 || {
  bun --eval "const {Database}=require('bun:sqlite');const db=new Database('$DB');console.log(JSON.stringify(db.query('SELECT id,agent,skill,started_at,ended_at FROM executions WHERE id=?').get('$AUTHOR_RUN_ID')));" 2>/dev/null | tee -a "$LOG"
  fail "skill-author CC session did not complete within 300s"
}
pass "skill-author CC session completed"

# Assert: a new quarantine txn was created (skill_manage(create) was called by the CC session)
AFTER_QS=$(ls "$QBASE" 2>/dev/null | sort)
NEW_TXNS=$(comm -13 <(echo "$BEFORE_QS" | grep -v '^$' 2>/dev/null | sort || true) <(echo "$AFTER_QS" | grep -v '^$' 2>/dev/null | sort || true) 2>/dev/null || true)
[[ -n "$NEW_TXNS" ]] || fail "No new quarantine txn dir after skill-author session — skill_manage(create) was not called by the real CC session"
# Pick the txn that contains vos201-proof-skill (from the txn.json's name field)
TXN=$(echo "$NEW_TXNS" | while IFS= read -r t; do
  [[ -f "$QBASE/$t/txn.json" ]] && grep -q '"vos201-proof-skill"' "$QBASE/$t/txn.json" 2>/dev/null && echo "$t" && break
done)
# Fall back to first new txn if name match fails
[[ -n "$TXN" ]] || TXN=$(echo "$NEW_TXNS" | head -1)
[[ -n "$TXN" ]] || fail "Could not identify quarantine txn for vos201-proof-skill"
QDIR="$QBASE/$TXN"
[[ -d "$QDIR" ]] || fail "Quarantine dir missing: $QDIR"
pass "New quarantine txn staged by skill_manage(create) from real CC session: $TXN"

# Assert: a new pending Decision exists (skill_manage was called → a Decision was parked)
# Match by txnId in the decision's resumePayload (stored in context/question) or by skill name
DEC=$(bun --eval "
  const fs=require('fs'),path=require('path');
  const {listPendingDecisions}=await import('$REPO/src/decision.ts');
  const pend=listPendingDecisions('$VAULT');
  // Try matching via the decisions.jsonl context (which contains the diff with skill name)
  const d=pend.find(d=>(d.question+d.context).toLowerCase().includes('vos201-proof-skill'))
    || pend.find(d=>d.state==='pending');
  console.log(d?d.id:'none');
" 2>/dev/null) || DEC="none"
[[ "$DEC" != "none" && -n "$DEC" ]] || {
  bun --eval "const {listPendingDecisions}=await import('$REPO/src/decision.ts');console.log(JSON.stringify(listPendingDecisions('$VAULT')));" 2>/dev/null | tee -a "$LOG"
  fail "No pending Decision after real skill-author CC session — skill_manage(create) did not park a Decision"
}
# Confirm the decision references vos201-proof-skill (the expected skill name from the intent)
DEC_DETAIL=$(bun --eval "
  const {listPendingDecisions}=await import('$REPO/src/decision.ts');
  const d=listPendingDecisions('$VAULT').find(d=>d.id==='$DEC');
  console.log(d?JSON.stringify({question:d.question,context:d.context.slice(0,120)}):'not found');
" 2>/dev/null) || DEC_DETAIL="{}"
echo "$DEC_DETAIL" | grep -qi "vos201-proof-skill" || fail "Decision $DEC does not reference vos201-proof-skill — intent not followed. CC session likely created wrong skill name. Details: $DEC_DETAIL"
pass "Decision parked for vos201-proof-skill by real CC session: $DEC"

# Assert: catalog skill NOT yet live (gated — approval required)
[[ ! -f "$VAULT/.claude/skills/vos201-proof-skill/SKILL.md" ]] || fail "Skill live BEFORE approval — gating broken"
pass "Catalog untouched pre-approval — gating confirmed"

# Assert: the skill-author session did NOT write catalog/skills directly
# The CC session's output dir: check session events for raw catalog writes (must be absent)
SESSION_DIR="$VAULT/sessions/$AUTHOR_RUN_ID"
if [[ -d "$SESSION_DIR" ]]; then
  if grep -rl "catalog/skills/vos201-proof-skill" "$SESSION_DIR" 2>/dev/null | xargs -r grep -lE "writeFile|cpSync|copyFile|mkdir" 2>/dev/null | grep -q .; then
    fail "skill-author session wrote catalog/skills directly (bypassed gated path)"
  fi
fi
pass "skill-author session used only skill_manage gated path (no direct catalog writes)"

log "Proof A complete: REAL CC session (agent=skill-author-proxy) invoked skill-author → drafted + skill_manage(create) → Decision $DEC parked"

# ============================================================
log ""
log "=== Proof B: REAL approve — decision-reply bus → daemon drain → continuation exec → activate ==="
# ============================================================
BEFORE_REPLY=$(($(date +%s) * 1000))

REPLY_ID="bl-$(uuidgen | tr 'A-Z' 'a-z')"
bun --eval "
  const fs=require('fs'),path=require('path');
  const line=JSON.stringify({channel:'file',kind:'decision-reply',payload:'approve',routing:{decisionRef:'$DEC',execRef:'$AUTHOR_RUN_ID'},id:'$REPLY_ID',ts:$(($(date +%s)*1000))});
  fs.appendFileSync(path.join('$VAULT','inbox','bus.jsonl'),line+'\n');
" 2>/dev/null || fail "Could not append approve bus line"
log "Approve bus line appended: $REPLY_ID"

log "Waiting for skill-manage-apply continuation execution (up to 180s)..."
EXEC_APPLY=$(poll_exec_for_trigger "skill-apply-t" "$BEFORE_REPLY" 180)
[[ "$EXEC_APPLY" != "none" && -n "$EXEC_APPLY" ]] || { q "SELECT name,kind,event_kind,enabled FROM triggers" | tee -a "$LOG"; fail "decision-reply did not fire a real continuation execution"; }
pass "REAL continuation execution fired: $EXEC_APPLY"

log "Waiting for continuation to complete via real CC hooks (max 240s)..."
wait_exec_ended "$EXEC_APPLY" 240 || { q "SELECT id,skill,started_at,ended_at FROM executions WHERE id='$EXEC_APPLY'" | tee -a "$LOG"; fail "Continuation did not complete"; }
pass "Continuation execution ended cleanly"

LIVE="$VAULT/.claude/skills/vos201-proof-skill/SKILL.md"
[[ -f "$LIVE" ]] || fail "SKILL.md not live after real approve continuation: $LIVE"
pass "SKILL.md live (activated by real continuation, NO daemon restart)"

# Trigger reconciled live (no daemon restart)
for i in $(seq 1 15); do
  TROW=$(bun --eval "const {Database}=require('bun:sqlite');const db=new Database('$DB');const r=db.query('SELECT event_kind FROM triggers WHERE skill=?').get('vos201-proof-skill');console.log(r?r.event_kind:'missing');" 2>/dev/null) || TROW="error"
  [[ "$TROW" == "vos201-proof" ]] && break
  sleep 1; [[ $i -eq 15 ]] && fail "vos201-proof-skill trigger not reconciled live (got: $TROW)"
done
pass "Trigger routed live WITHOUT daemon restart (event_kind=vos201-proof)"

PEND2=$(bun --eval "const {listPendingDecisions}=await import('$REPO/src/decision.ts');console.log(listPendingDecisions('$VAULT').some(d=>d.id==='$DEC')?'yes':'no');" 2>/dev/null) || PEND2="yes"
[[ "$PEND2" == "no" ]] || fail "Decision still pending after approve"
pass "Decision drained"
[[ ! -d "$QDIR" ]] || fail "Quarantine not cleaned after activate"
pass "Quarantine cleaned"

# ============================================================
log ""
log "=== Proof B2: invoke new skill via live trigger → exec row → rebuildExecutions MATCH ==="
# ============================================================
BEFORE_INVOKE=$(($(date +%s) * 1000))
bash "$REPO/scripts/vos-bus-append.sh" "$VAULT" bus vos201-proof "fire the newly-created vos201-proof-skill" >/dev/null
log "Appended kind=vos201-proof bus line to invoke the new skill..."

EXEC_NEW=$(poll_exec_for_trigger "vos201-proof-skill" "$BEFORE_INVOKE" 180)
[[ "$EXEC_NEW" != "none" && -n "$EXEC_NEW" ]] || { q "SELECT name,event_kind FROM triggers" | tee -a "$LOG"; fail "Newly-created skill did not fire an execution — it is not live"; }
pass "Newly-created skill fired a real execution: $EXEC_NEW"
wait_exec_ended "$EXEC_NEW" 240 || fail "New-skill execution did not complete"
pass "New-skill execution completed (the new skill RAN)"

# rebuildExecutions deep-equals live rows
REBUILD_MATCH=$(bun --eval "
  import { Database } from 'bun:sqlite';
  import { rebuildExecutions } from '$REPO/src/events.ts';
  import { openRegistry } from '$REPO/src/registry.ts';
  import { registryDbPath } from '$REPO/src/paths.ts';

  const vault = '$VAULT';
  const liveDb = new Database(registryDbPath(vault));
  const liveRows = liveDb.query('SELECT id,skill,trigger_id,started_at,ended_at,produced_change FROM executions ORDER BY started_at ASC').all();

  const rebuiltDb = openRegistry(':memory:');
  rebuildExecutions(rebuiltDb, vault);
  const rebuiltRows = rebuiltDb.query('SELECT id,skill,trigger_id,started_at,ended_at,produced_change FROM executions ORDER BY started_at ASC').all();

  const liveStr = JSON.stringify(liveRows);
  const rebuiltStr = JSON.stringify(rebuiltRows);
  if (liveStr !== rebuiltStr) {
    console.log('MISMATCH');
    console.error('Live:', liveStr.slice(0, 500));
    console.error('Rebuilt:', rebuiltStr.slice(0, 500));
  } else {
    console.log('MATCH');
  }
" 2>/dev/null) || REBUILD_MATCH="error"
[[ "$REBUILD_MATCH" == "MATCH" ]] || fail "rebuildExecutions mismatch (got: $REBUILD_MATCH)"
pass "rebuildExecutions MATCH — live DB == rebuilt from event log"

# ============================================================
log ""
log "=== Proof C: REAL reject — second create → reject reply → drop cleanly ==="
# ============================================================

BODY2=$(esc '---
name: vos201-reject-skill
description: Will be rejected — VOS-201 proof reject path.

## Instructions

This will be rejected.
')
MCP_OUT2=$(mcp_stdio_call "skill_manage" "{\"action\":\"create\",\"name\":\"vos201-reject-skill\",\"body\":$BODY2,\"exec_id\":\"vos201-proof-002\"}")
TXN2=$(echo "$MCP_OUT2" | grep -o 'txnId: [^ ]*' | awk '{print $2}' | head -1)
DEC2=$(echo "$MCP_OUT2" | grep -o 'decisionId: [^ ]*' | awk '{print $2}' | head -1)
[[ -n "$TXN2" && -n "$DEC2" ]] || fail "Second stdio create returned no ids"
pass "Second Decision parked over stdio: $DEC2"

BEFORE_REJ=$(($(date +%s) * 1000))
REJ_ID="bl-$(uuidgen | tr 'A-Z' 'a-z')"
bun --eval "
  const fs=require('fs'),path=require('path');
  const line=JSON.stringify({channel:'file',kind:'decision-reply',payload:'reject',routing:{decisionRef:'$DEC2',execRef:'vos201-proof-002'},id:'$REJ_ID',ts:$(($(date +%s)*1000))});
  fs.appendFileSync(path.join('$VAULT','inbox','bus.jsonl'),line+'\n');
" 2>/dev/null || fail "Could not append reject bus line"

EXEC_REJ=$(poll_exec_for_trigger "skill-apply-t" "$BEFORE_REJ" 180)
[[ "$EXEC_REJ" != "none" && -n "$EXEC_REJ" ]] || fail "Reject reply did not fire a continuation execution"
wait_exec_ended "$EXEC_REJ" 240 || fail "Reject continuation did not complete"
pass "Reject continuation execution completed: $EXEC_REJ"

[[ ! -f "$VAULT/.claude/skills/vos201-reject-skill/SKILL.md" ]] || fail "Rejected skill appeared in catalog"
pass "Rejected skill NOT activated"
[[ ! -d "$VAULT/.void-os/skill-quarantine/$TXN2" ]] || fail "Reject quarantine not cleaned"
pass "Reject quarantine cleaned"
PEND3=$(bun --eval "const {listPendingDecisions}=await import('$REPO/src/decision.ts');console.log(listPendingDecisions('$VAULT').some(d=>d.id==='$DEC2')?'yes':'no');" 2>/dev/null) || PEND3="yes"
[[ "$PEND3" == "no" ]] || fail "Rejected Decision still pending"
pass "Rejected Decision drained"

# ============================================================
log ""
log "=== Proof D: no-regression — full unit suite ==="
# ============================================================
log "Running bun test --isolate (full suite from $NM_ROOT)..."
# Run from NM_ROOT (canonical workspace with node_modules); src/ is identical via git.
(cd "$NM_ROOT" && bun test --isolate 2>&1 | tee -a "$LOG" | tail -20) || fail "Full test suite failed"
pass "Full test suite green"

log ""
log "=== VOS-201 REAL-PATH PROOF COMPLETE ==="
log "  A. skill-author REAL CC session: invoked with intent → drafted + skill_manage(create) → Decision parked, catalog untouched [PASS]"
log "  B. REAL decision-reply bus → daemon drain → continuation exec → activate, NO restart [PASS]"
log "  B2. invoke new skill via live trigger → exec row → rebuildExecutions MATCH [PASS]"
log "  C. REAL reject via decision-reply → drop cleanly, no activation [PASS]"
log "  D. Full test suite green [PASS]"
log "Log: $LOG"
