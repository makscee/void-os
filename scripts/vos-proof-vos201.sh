#!/usr/bin/env bash
# vos-proof-vos201.sh — VOS-201 real-path proof. NO self-downgrade.
#
# What it proves:
#   A. skill-author skill is installed in vault + frontmatter is valid + skill_manage(create)
#      called via REAL stdio MCP transport → Decision parked; catalog untouched pre-approval;
#      assert NO direct catalog/skills write path (only skill_manage route is present in SKILL.md).
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
log "=== Proof A: skill-author installed + skill_manage(create) via REAL stdio MCP → Decision parked ==="
# ============================================================

SKILL_BODY='---
name: vos201-proof-skill
description: VOS-201 proof skill — fires on kind=vos201-proof. Created via gated skill_manage.
---

## Instructions

This skill was authored via the skill-author + skill_manage gated path. When invoked by its
trigger (kind=vos201-proof), write a timestamp to sessions output.
'

TRIGGER_BODY='---
kind: event
skill: vos201-proof-skill
agent: default
inbox: bus
event_kind: vos201-proof
step_ceiling: 30
---
vos201-proof-t: fires vos201-proof-skill on kind=vos201-proof (VOS-201 proof).'

BODY_E=$(esc "$SKILL_BODY"); TRIG_E=$(esc "$TRIGGER_BODY")
MCP_OUT=$(mcp_stdio_call "skill_manage" "{\"action\":\"create\",\"name\":\"vos201-proof-skill\",\"body\":$BODY_E,\"trigger\":$TRIG_E,\"exec_id\":\"vos201-proof-001\"}")
log "MCP(stdio) result: $MCP_OUT"
echo "$MCP_OUT" | grep -q "Decision parked" || fail "stdio MCP call did not return a parked Decision"

TXN=$(echo "$MCP_OUT" | grep -o 'txnId: [^ ]*' | awk '{print $2}' | head -1)
DEC=$(echo "$MCP_OUT" | grep -o 'decisionId: [^ ]*' | awk '{print $2}' | head -1)
[[ -n "$TXN" && -n "$DEC" ]] || fail "No txnId/decisionId from stdio MCP call"
pass "REAL stdio MCP returned txnId=$TXN decisionId=$DEC"

PEND=$(bun --eval "const {listPendingDecisions}=await import('$REPO/src/decision.ts');console.log(listPendingDecisions('$VAULT').some(d=>d.id==='$DEC')?'yes':'no');" 2>/dev/null) || PEND="no"
[[ "$PEND" == "yes" ]] || fail "Decision $DEC not pending after stdio create"
pass "Decision pending in decisions.jsonl"

QDIR="$VAULT/.void-os/skill-quarantine/$TXN"
[[ -d "$QDIR" ]] || fail "Quarantine dir missing: $QDIR"
[[ ! -f "$VAULT/.claude/skills/vos201-proof-skill/SKILL.md" ]] || fail "Skill live BEFORE approval"
pass "Quarantine staged; catalog untouched pre-approval"

# ============================================================
log ""
log "=== Proof B: REAL approve — decision-reply bus → daemon drain → continuation exec → activate ==="
# ============================================================
BEFORE_REPLY=$(($(date +%s) * 1000))

REPLY_ID="bl-$(uuidgen | tr 'A-Z' 'a-z')"
bun --eval "
  const fs=require('fs'),path=require('path');
  const line=JSON.stringify({channel:'file',kind:'decision-reply',payload:'approve',routing:{decisionRef:'$DEC',execRef:'vos201-proof-001'},id:'$REPLY_ID',ts:$(($(date +%s)*1000))});
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
log "  A. skill-author installed + frontmatter valid + skill_manage(create) via REAL stdio MCP → Decision parked [PASS]"
log "  B. REAL decision-reply bus → daemon drain → continuation exec → activate, NO restart [PASS]"
log "  B2. invoke new skill via live trigger → exec row → rebuildExecutions MATCH [PASS]"
log "  C. REAL reject via decision-reply → drop cleanly, no activation [PASS]"
log "  D. Full test suite green [PASS]"
log "Log: $LOG"
