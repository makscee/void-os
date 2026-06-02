#!/usr/bin/env bash
# vos-proof-vos199-stdio.sh — VOS-199 finalizer real-path proof. NO self-downgrade.
#
# Independent of the impl's vos-proof-vos199.sh (which used InMemoryTransport + a
# hand-rolled apply eval). This proof exercises the GENUINE production path:
#   - REAL stdio MCP transport: spawn src/mcp-server.ts as a child process, connect a
#     real StdioClientTransport MCP client over stdin/stdout.
#   - REAL approve path: append a kind=decision-reply bus line → live daemon drainInbox
#     → skill-manage-apply continuation CC execution (NOT a bun eval proxy) → activate.
#   - Assert: SKILL.md live + trigger reconciled WITH NO daemon restart → invoke the new
#     bus-bound skill via its trigger → executions row appears → rebuildExecutions MATCH.
#   - REAL reject path: second create → reject reply → drop cleanly, no activation.
#
# Requires: vc authenticated, bun, void-os source.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT="/tmp/void-os-vos199-stdio-proof"
DB="$VAULT/.void-os/registry.db"
PORT=14398
DAEMON_URL="http://127.0.0.1:$PORT"
LOG="/tmp/vos199-stdio-proof.log"
DAEMON_PID=""

cleanup() {
  [[ -n "$DAEMON_PID" ]] && { kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true; }
  tmux ls 2>/dev/null | grep "^vos-run-" | cut -d: -f1 | xargs -I{} tmux kill-session -t {} 2>/dev/null || true
}
trap cleanup EXIT

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
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

rm -f "$LOG"
log "=== VOS-199 finalizer REAL-STDIO real-path proof ==="
lsof -ti :$PORT 2>/dev/null | xargs kill -9 2>/dev/null || true

# ---- Setup vault + triggers BEFORE daemon start ----
rm -rf "$VAULT"
mkdir -p "$VAULT/triggers" "$VAULT/inbox" "$VAULT/sessions" "$VAULT/.claude/skills"
cat > "$VAULT/void-os.json" <<EOF
{ "vault": "$VAULT", "onboarded": true, "skills": ["skill-manage-apply"], "answers": {}, "port": $PORT, "runners": [{"label":"vc (relay)","command":"vc --"}], "defaultRunner": "vc (relay)" }
EOF

# skill-manage-apply continuation, fired by kind=decision-reply lines
cp -r "$REPO/catalog/skills/skill-manage-apply" "$VAULT/.claude/skills/"
[[ -f "$REPO/templates/CLAUDE.md" ]] && cp "$REPO/templates/CLAUDE.md" "$VAULT/CLAUDE.md"
cat > "$VAULT/triggers/skill-apply-t.md" << 'EOF'
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

# ---- Start daemon ----
log "Starting daemon (port $PORT)..."
VOID_OS_VAULT="$VAULT" bun run "$REPO/src/cli.ts" serve --no-open >> "$LOG" 2>&1 &
DAEMON_PID=$!
for i in $(seq 1 25); do
  kill -0 "$DAEMON_PID" 2>/dev/null || fail "Daemon died before ready"
  bun --eval "const r=await fetch('$DAEMON_URL/').catch(()=>null);process.exit(r?0:1);" 2>/dev/null && { log "Daemon ready (pid $DAEMON_PID)"; break; }
  sleep 1; [[ $i -eq 25 ]] && fail "Daemon not ready in 25s"
done

# ---- Real stdio MCP helper: spawns mcp-server.ts as a child, connects real StdioClientTransport ----
mcp_stdio_call() {
  local tool="$1" args_json="$2"
  REPO="$REPO" VAULT="$VAULT" MCP_TOOL="$tool" MCP_ARGS="$args_json" bun --eval "
    const { Client } = await import('$REPO/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
    const { StdioClientTransport } = await import('$REPO/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
    const transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', process.env.REPO + '/src/mcp-server.ts'],
      env: { ...process.env, VOID_OS_VAULT: process.env.VAULT, VOID_OS_MCP_DIRECT: '1' },
    });
    const client = new Client({ name: 'finalizer-stdio-proof', version: '1.0.0' }, { capabilities: {} });
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

# ============================================================
# Proof A: REAL stdio MCP skill_manage(create) → Decision parked
# ============================================================
log ""
log "=== Proof A: REAL stdio transport — skill_manage(create) → Decision parked ==="

SKILL_BODY='---
name: stdio-proof-skill
description: A bus-bound skill created over a real stdio MCP transport
version: 1.0.0
output_target: .void-os/stdio-proof-out/*.json
---

## Instructions

You are the stdio-proof-skill. Write a JSON file to .void-os/stdio-proof-out/$VOID_OS_SESSION.json
containing {"ran": true} then STOP.

```bash
mkdir -p .void-os/stdio-proof-out
echo "{\"ran\": true}" > .void-os/stdio-proof-out/$VOID_OS_SESSION.json
```
'
TRIGGER_BODY='---
kind: event
skill: stdio-proof-skill
agent: default
inbox: bus
event_kind: stdio-proof
step_ceiling: 20
---
stdio-proof-t: fires stdio-proof-skill on kind=stdio-proof... (created live, no restart).
'

BODY_E=$(esc "$SKILL_BODY"); TRIG_E=$(esc "$TRIGGER_BODY")
MCP_OUT=$(mcp_stdio_call "skill_manage" "{\"action\":\"create\",\"name\":\"stdio-proof-skill\",\"body\":$BODY_E,\"trigger\":$TRIG_E,\"exec_id\":\"stdio-proof-001\"}")
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
[[ ! -f "$VAULT/.claude/skills/stdio-proof-skill/SKILL.md" ]] || fail "Skill live BEFORE approval"
pass "Quarantine staged; catalog untouched pre-approval"

# ============================================================
# Proof B: REAL approve path — decision-reply bus → daemon drain → continuation execution
# ============================================================
log ""
log "=== Proof B: REAL approve — decision-reply bus → daemon drain → continuation exec ==="
BEFORE_REPLY=$(($(date +%s) * 1000))

REPLY_ID="bl-$(uuidgen | tr 'A-Z' 'a-z')"
bun --eval "
  const fs=require('fs'),path=require('path');
  const line=JSON.stringify({channel:'file',kind:'decision-reply',payload:'approve',routing:{decisionRef:'$DEC',execRef:'stdio-proof-001'},id:'$REPLY_ID',ts:$(($(date +%s)*1000))});
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

LIVE="$VAULT/.claude/skills/stdio-proof-skill/SKILL.md"
[[ -f "$LIVE" ]] || fail "SKILL.md not live after real approve continuation: $LIVE"
pass "SKILL.md live (activated by real continuation, NO daemon restart)"

# Trigger reconciled live in the SAME daemon process (no restart)
for i in $(seq 1 15); do
  TROW=$(bun --eval "const {Database}=require('bun:sqlite');const db=new Database('$DB');const r=db.query('SELECT event_kind FROM triggers WHERE skill=?').get('stdio-proof-skill');console.log(r?r.event_kind:'missing');" 2>/dev/null) || TROW="error"
  [[ "$TROW" == "stdio-proof" ]] && break
  sleep 1; [[ $i -eq 15 ]] && fail "stdio-proof-skill trigger not reconciled live (got: $TROW)"
done
pass "Trigger routed live WITHOUT daemon restart (event_kind=stdio-proof)"

PEND2=$(bun --eval "const {listPendingDecisions}=await import('$REPO/src/decision.ts');console.log(listPendingDecisions('$VAULT').some(d=>d.id==='$DEC')?'yes':'no');" 2>/dev/null) || PEND2="yes"
[[ "$PEND2" == "no" ]] || fail "Decision still pending after approve"
pass "Decision drained"
[[ ! -d "$QDIR" ]] || fail "Quarantine not cleaned after activate"
pass "Quarantine cleaned"

AUDIT="$VAULT/.void-os/skill-audit.log"
grep -q '"action":"create"' "$AUDIT" || fail "Audit log missing create entry"
pass "Audit log has create entry"

# ============================================================
# Proof B2: INVOKE the newly-activated skill via its live trigger → executions row → rebuild MATCH
# ============================================================
log ""
log "=== Proof B2: invoke new skill via live trigger → exec row → rebuildExecutions MATCH ==="
BEFORE_INVOKE=$(($(date +%s) * 1000))
bash "$REPO/scripts/vos-bus-append.sh" "$VAULT" bus stdio-proof "fire the newly-created stdio-proof-skill" >/dev/null
log "Appended kind=stdio-proof bus line to invoke the new skill..."

EXEC_NEW=$(poll_exec_for_trigger "stdio-proof-t" "$BEFORE_INVOKE" 180)
[[ "$EXEC_NEW" != "none" && -n "$EXEC_NEW" ]] || { q "SELECT name,event_kind FROM triggers" | tee -a "$LOG"; fail "Newly-created skill did not fire an execution — it is not live"; }
pass "Newly-created skill fired a real execution: $EXEC_NEW"
wait_exec_ended "$EXEC_NEW" 240 || fail "New-skill execution did not complete"
pass "New-skill execution completed (the new skill RAN)"

# rebuildExecutions deep-equals live rows
MATCH=$(bun --eval "
  const {Database}=require('bun:sqlite');
  const {rebuildExecutions}=await import('$REPO/src/events.ts');
  const db=new Database('$DB');
  const live=db.query('SELECT id,skill,trigger_id,started_at,ended_at,input_ref FROM executions ORDER BY id').all();
  const rebuilt=rebuildExecutions(db).map(r=>({id:r.id,skill:r.skill,trigger_id:r.trigger_id,started_at:r.started_at,ended_at:r.ended_at,input_ref:r.input_ref})).sort((a,b)=>a.id<b.id?-1:1);
  const liveS=[...live].sort((a,b)=>a.id<b.id?-1:1);
  console.log(JSON.stringify(liveS)===JSON.stringify(rebuilt)?'MATCH':'MISMATCH:'+JSON.stringify({live:liveS.length,rebuilt:rebuilt.length}));
" 2>>"$LOG") || MATCH="error"
[[ "$MATCH" == "MATCH" ]] || fail "rebuildExecutions did not deep-equal live rows: $MATCH"
pass "rebuildExecutions MATCH live rows"

# ============================================================
# Proof C: REAL reject path — second create → reject reply → drop cleanly
# ============================================================
log ""
log "=== Proof C: REAL reject — decision-reply 'reject' → drop, no activation ==="
BODY2=$(esc '---
name: stdio-reject-skill
description: Will be rejected over stdio
---

## Instructions

This will be rejected.
')
MCP_OUT2=$(mcp_stdio_call "skill_manage" "{\"action\":\"create\",\"name\":\"stdio-reject-skill\",\"body\":$BODY2,\"exec_id\":\"stdio-proof-002\"}")
TXN2=$(echo "$MCP_OUT2" | grep -o 'txnId: [^ ]*' | awk '{print $2}' | head -1)
DEC2=$(echo "$MCP_OUT2" | grep -o 'decisionId: [^ ]*' | awk '{print $2}' | head -1)
[[ -n "$TXN2" && -n "$DEC2" ]] || fail "Second stdio create returned no ids"
pass "Second Decision parked over stdio: $DEC2"

BEFORE_REJ=$(($(date +%s) * 1000))
REJ_ID="bl-$(uuidgen | tr 'A-Z' 'a-z')"
bun --eval "
  const fs=require('fs'),path=require('path');
  const line=JSON.stringify({channel:'file',kind:'decision-reply',payload:'reject',routing:{decisionRef:'$DEC2',execRef:'stdio-proof-002'},id:'$REJ_ID',ts:$(($(date +%s)*1000))});
  fs.appendFileSync(path.join('$VAULT','inbox','bus.jsonl'),line+'\n');
" 2>/dev/null || fail "Could not append reject bus line"

EXEC_REJ=$(poll_exec_for_trigger "skill-apply-t" "$BEFORE_REJ" 180)
[[ "$EXEC_REJ" != "none" && -n "$EXEC_REJ" ]] || fail "Reject reply did not fire a continuation execution"
wait_exec_ended "$EXEC_REJ" 240 || fail "Reject continuation did not complete"
pass "Reject continuation execution completed: $EXEC_REJ"

[[ ! -f "$VAULT/.claude/skills/stdio-reject-skill/SKILL.md" ]] || fail "Rejected skill appeared in catalog"
pass "Rejected skill NOT activated"
[[ ! -d "$VAULT/.void-os/skill-quarantine/$TXN2" ]] || fail "Reject quarantine not cleaned"
pass "Reject quarantine cleaned"
PEND3=$(bun --eval "const {listPendingDecisions}=await import('$REPO/src/decision.ts');console.log(listPendingDecisions('$VAULT').some(d=>d.id==='$DEC2')?'yes':'no');" 2>/dev/null) || PEND3="yes"
[[ "$PEND3" == "no" ]] || fail "Rejected Decision still pending"
pass "Rejected Decision drained"

log ""
log "=== VOS-199 STDIO REAL-PATH PROOF COMPLETE ==="
log "  A. REAL stdio MCP skill_manage(create) → Decision parked [PASS]"
log "  B. REAL decision-reply bus → daemon drain → continuation exec → activate, NO restart [PASS]"
log "  B2. invoke new skill via live trigger → exec row → rebuildExecutions MATCH [PASS]"
log "  C. REAL reject via decision-reply → drop cleanly, no activation [PASS]"
log "Log: $LOG"
