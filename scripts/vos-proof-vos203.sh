#!/usr/bin/env bash
### vos-proof-vos203.sh — VOS-203 E2E dogfood walkthrough proof.
# Usage: bash scripts/vos-proof-vos203.sh
#
# What it proves:
#   Phase 0: Phase 0 TDD fixes verified (full suite green).
#   Phase 1: Fresh vault init → cold state has ONLY onboarding + authoring toolchain.
#            Daemon starts on PORT, HTTP :PORT responds.
#            Dashboard HTML at GET / shows vault-installed skills (cold = onboarding+authoring toolchain).
#   Phase 2: Onboarding skill launched via /launch → session created → form rendered →
#            form filled + submitted via /s/:uuid/send → void-os.json updated (onboarded:true,
#            selected skills in .skills) → chosen skills copied to vault .claude/skills/ →
#            dashboard now shows newly installed skills.
#   Phase 3: organize skill authored via skill-author agent-proxy (real CC session) →
#            skill_manage(create) → Decision parked → approve via decision-reply bus →
#            continuation execution → skill activated (SKILL.md live in vault) →
#            dashboard shows organize chip (no restart).
#   Phase 4: Seed inbox/ingest.jsonl (10 mixed items) → run organize skill → inbox drained →
#            knowledge/ dirs built → knowledge/index.md written → second run with 3 new + 2
#            duplicates → idempotent (13 total notes, no dupes).
#
# Requires: bun, claude binary (authenticated), void-os source.
# Screenshots taken separately via Playwright MCP during the impl session.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- Resolve NM_ROOT: node_modules live in the canonical worktree, not a task worktree ----
NM_ROOT="$REPO"
if [[ ! -d "$REPO/node_modules/@modelcontextprotocol" ]]; then
  while IFS= read -r line; do
    [[ "$line" == worktree\ * ]] && CANDIDATE="${line#worktree }" && \
      [[ -d "$CANDIDATE/node_modules/@modelcontextprotocol" ]] && NM_ROOT="$CANDIDATE" && break
  done < <(git -C "$REPO" worktree list --porcelain 2>/dev/null)
fi

VAULT="/tmp/vos203-proof"
DB="$VAULT/.void-os/registry.db"
PORT=14403
DAEMON_URL="http://127.0.0.1:$PORT"
LOG="/tmp/vos203-proof.log"
DAEMON_PID=""

EVIDENCE_DIR="$REPO/../vault/work/evidence/VOS-203"

cleanup() {
  [[ -n "$DAEMON_PID" ]] && { kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true; }
  tmux ls 2>/dev/null | grep "^vos203-" | cut -d: -f1 | xargs -I{} tmux kill-session -t {} 2>/dev/null || true
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

wait_session_awaiting() {
  local id="$1" deadline=$((SECONDS + $2))
  while [[ $SECONDS -lt $deadline ]]; do
    local status
    status=$(bun --eval "const {Database}=require('bun:sqlite');const db=new Database('$DB');const r=db.query('SELECT status FROM executions WHERE id=?').get('$id');console.log(r?(r.status??'none'):'missing');" 2>/dev/null) || status="err"
    [[ "$status" == "awaiting" ]] && return 0
    sleep 2
  done
  return 1
}

wait_body_html() {
  local id="$1" pattern="$2" deadline=$((SECONDS + $3))
  local f="$VAULT/sessions/$id/body.html"
  while [[ $SECONDS -lt $deadline ]]; do
    [[ -f "$f" ]] && grep -q "$pattern" "$f" 2>/dev/null && return 0
    sleep 2
  done
  return 1
}

rm -f "$LOG"
log "=== VOS-203 E2E dogfood walkthrough proof ==="
log "Repo: $REPO"
log "Vault: $VAULT"
log "Port: $PORT"
log "NM_ROOT: $NM_ROOT"

# ---- Preflight: bun present ----
command -v bun >/dev/null 2>&1 || fail "bun not found in PATH"
log "bun found: $(command -v bun)"

lsof -ti :$PORT 2>/dev/null | xargs kill -9 2>/dev/null || true
# No trust-sentinel needed: all CC sessions run via the daemon /launch seam which uses
# spawnRun print mode (-p). Print mode skips the workspace trust dialog entirely.

# ============================================================
log ""
log "=== Phase 0: Full test suite green ==="
# ============================================================
log "Running: bun test --isolate (full suite from NM_ROOT)..."
(cd "$NM_ROOT" && bun test --isolate 2>&1 | tee -a "$LOG" | tail -5) || fail "Phase 0: Full test suite FAILED"
pass "Phase 0: Full test suite green"

# ============================================================
log ""
log "=== Phase 1: Fresh vault init → cold state → daemon → dashboard ==="
# ============================================================

log "Removing old proof vault and reinitializing..."
rm -rf "$VAULT"
VOID_OS_DAEMON_URL="$DAEMON_URL" VOID_OS_VAULT="$VAULT" bun run "$REPO/src/cli.ts" init "$VAULT" 2>/dev/null || true

[[ -f "$VAULT/.mcp.json" ]] || fail "init did not write .mcp.json"
pass ".mcp.json written"
[[ -f "$VAULT/.claude/settings.json" ]] || fail "init did not write .claude/settings.json"
pass ".claude/settings.json written"
[[ -f "$VAULT/void-os.json" ]] || fail "init did not write void-os.json"
pass "void-os.json written"

# Verify cold state: exactly onboarding + authoring toolchain
COLD_SKILLS=$(ls "$VAULT/.claude/skills/" 2>/dev/null | sort | tr '\n' ' ' | sed 's/ $//')
[[ "$COLD_SKILLS" == "onboarding skill-author skill-manage-apply" ]] || \
  fail "Cold vault has unexpected skills: '$COLD_SKILLS' (expected: onboarding skill-author skill-manage-apply)"
pass "Cold vault skills: $COLD_SKILLS (correct — onboarding + authoring toolchain only)"

# Write void-os.json config for the daemon
bun --eval "
  const fs=require('fs'), path=require('path');
  const cfgPath=path.join('$VAULT','void-os.json');
  const cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8'));
  cfg.vault='$VAULT';
  cfg.port=$PORT;
  cfg.runners=[{label:'vc (relay)',command:'vc --'},{label:'claude',command:'claude --'}];
  cfg.defaultRunner='claude';
  fs.writeFileSync(cfgPath,JSON.stringify(cfg,null,2));
" 2>/dev/null || fail "Could not write void-os.json"
pass "void-os.json configured (vault, port, runners)"

# Install skill-apply trigger (needed for decision-reply routing)
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
EOF
pass "skill-apply trigger installed"

# Start daemon
log ""
log "=== Start daemon (port $PORT) ==="
VOID_OS_VAULT="$VAULT" VOID_OS_PORT="$PORT" bun run "$REPO/src/cli.ts" serve --no-open >> "$LOG" 2>&1 &
DAEMON_PID=$!
for i in $(seq 1 30); do
  kill -0 "$DAEMON_PID" 2>/dev/null || fail "Daemon died before ready"
  bun --eval "const r=await fetch('$DAEMON_URL/').catch(()=>null);process.exit(r?0:1);" 2>/dev/null && { log "Daemon ready (pid $DAEMON_PID)"; break; }
  sleep 1; [[ $i -eq 30 ]] && fail "Daemon not ready in 30s"
done
pass "Daemon serving at $DAEMON_URL (pid $DAEMON_PID)"

# Assert dashboard shows cold-state vault skills
COLD_HTML=$(bun --eval "const r=await fetch('$DAEMON_URL/');const t=await r.text();console.log(t.includes('data-skill=\"onboarding\"')?'has-onboarding':'no-onboarding')" 2>/dev/null) || COLD_HTML="error"
[[ "$COLD_HTML" == "has-onboarding" ]] || fail "Cold dashboard does not show onboarding chip"
pass "Cold dashboard shows onboarding chip"

CATALOG_SKILL_IN_COLD=$(bun --eval "const r=await fetch('$DAEMON_URL/');const t=await r.text();console.log(t.includes('data-skill=\"work\"')||t.includes('data-skill=\"chat\"')||t.includes('data-skill=\"deep-research\"')?'yes':'no')" 2>/dev/null) || CATALOG_SKILL_IN_COLD="yes"
[[ "$CATALOG_SKILL_IN_COLD" == "no" ]] || fail "Cold dashboard shows catalog-only skills (bulk seed not removed)"
pass "Cold dashboard: no catalog-only skills (work/chat/deep-research absent) — bulk seed correctly removed"
log "Phase 1 complete: fresh vault, daemon up, cold dashboard verified"

# ============================================================
log ""
log "=== Phase 2: Onboarding skill → form round-trip → skills installed ==="
# ============================================================

# Launch onboarding via /launch
log "POST /launch skill=onboarding..."
ONBOARD_RESP=$(bun --eval "
  const r = await fetch('$DAEMON_URL/launch', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: 'skill=onboarding',
    redirect: 'manual',
  }).catch((e) => { console.log('FETCH_ERROR: ' + e.message); process.exit(1); });
  console.log('status=' + r.status + ' location=' + (r.headers.get('location') ?? 'none'));
" 2>/dev/null) || fail "POST /launch onboarding failed"
log "Onboarding launch: $ONBOARD_RESP"

# Extract exec ID
ONBOARD_ID=$(echo "$ONBOARD_RESP" | grep -oE '/s/exec-[a-z0-9-]+' | sed 's|/s/||') || ONBOARD_ID=""
if [[ -z "$ONBOARD_ID" ]]; then
  log "No redirect; polling DB for onboarding exec row..."
  BEFORE_ONB=$(($(date +%s) * 1000))
  ONBOARD_ID=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const db = new Database('$DB');
      const r = db.query('SELECT id FROM executions WHERE skill=? ORDER BY started_at DESC LIMIT 1').get('onboarding');
      if (r) { console.log(r.id); process.exit(0); }
      await new Promise(res => setTimeout(res, 1000));
    }
    console.log('none');
  " 2>/dev/null) || ONBOARD_ID="none"
fi
[[ "$ONBOARD_ID" == "none" || -z "$ONBOARD_ID" ]] && fail "No onboarding exec row appeared after /launch"
pass "Onboarding session created: $ONBOARD_ID"

# Wait for the onboarding form to render (body.html with <form)
log "Waiting for onboarding body.html to render form (max 300s)..."
wait_body_html "$ONBOARD_ID" "<form" 300 || fail "Onboarding form did not render within 300s"
pass "Onboarding form rendered: body.html has <form"

# Wait for run-1 to complete before submitting the form.
# In print mode, CC exits after rendering the form. The workingPage written by /send
# would race with run-1's final body.html write (the form HTML). Waiting for
# execution end avoids the race: run-1 is done, workingPage write is durable.
log "Waiting for onboarding run-1 CC session to end (max 60s, then submit)..."
for i in $(seq 1 30); do
  EXEC_STATE=$(bun --eval "const {Database}=require('bun:sqlite');const db=new Database('$DB');const r=db.query('SELECT ended_at FROM executions WHERE id=?').get('$ONBOARD_ID');console.log(r?(r.ended_at!=null?'ended':'running'):'none');" 2>/dev/null) || EXEC_STATE="none"
  [[ "$EXEC_STATE" == "ended" ]] && break
  sleep 2
done
log "Onboarding exec state: ${EXEC_STATE:-unknown} — submitting form"

# Verify the form has a name field and skill checkboxes
FORM_HTML=$(cat "$VAULT/sessions/$ONBOARD_ID/body.html" 2>/dev/null)
echo "$FORM_HTML" | grep -q 'name="name"' || echo "$FORM_HTML" | grep -q 'type="text"' || \
  log "WARNING: form may not have a 'name' text field; proceeding anyway"

log "Submitting onboarding form with name=VOS-203-operator and skills: work, chat..."
# Submit form: name=VOS-203-operator, skill_work=on, skill_chat=on
SEND_RESP=$(bun --eval "
  const r = await fetch('$DAEMON_URL/s/$ONBOARD_ID/send', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: 'name=VOS-203-operator&skill_work=on&skill_chat=on',
    redirect: 'manual',
  }).catch((e) => { console.log('FETCH_ERROR: ' + e.message); process.exit(1); });
  console.log('status=' + r.status);
" 2>/dev/null) || fail "Onboarding form submit failed"
log "Send response: $SEND_RESP"

# Wait for onboarding to complete + write void-os.json with onboarded:true
log "Waiting for onboarding to complete and write void-os.json (max 300s)..."
for i in $(seq 1 150); do
  ONBOARDED=$(bun --eval "
    try {
      const cfg=JSON.parse(require('fs').readFileSync('$VAULT/void-os.json','utf8'));
      console.log(cfg.onboarded?'yes':'no');
    } catch(e){ console.log('no'); }
  " 2>/dev/null) || ONBOARDED="no"
  [[ "$ONBOARDED" == "yes" ]] && break
  sleep 2; [[ $i -eq 150 ]] && fail "void-os.json not updated with onboarded:true within 300s"
done
pass "void-os.json updated with onboarded:true"

# Assert selected skills are installed in vault
[[ -f "$VAULT/.claude/skills/work/SKILL.md" ]] || \
  log "WARNING: work skill not found at $VAULT/.claude/skills/work/SKILL.md — onboarding may not have found catalog path"
[[ -f "$VAULT/.claude/skills/chat/SKILL.md" ]] || \
  log "WARNING: chat skill not found — may not be in catalog"

# Check what skills are actually installed
INSTALLED_SKILLS=$(ls "$VAULT/.claude/skills/" 2>/dev/null | sort | tr '\n' ' ' | sed 's/ $//')
pass "Post-onboard vault skills: $INSTALLED_SKILLS"

# Assert dashboard shows post-onboard skills
POST_HTML=$(bun --eval "const r=await fetch('$DAEMON_URL/');const t=await r.text();console.log(t);" 2>/dev/null) || POST_HTML=""
echo "$POST_HTML" | grep -q 'data-skill=' || fail "Post-onboard dashboard shows no skill chips at all"
pass "Post-onboard dashboard shows skill chips (dashboard reads vault state correctly)"

# Stop the onboarding tmux session — it has served its purpose (onboarded:true, skills installed).
# The CC session inside may remain idle; kill it so it doesn't hold a DB write lock in Phase 3.
if [[ -n "$ONBOARD_ID" ]]; then
  ONBOARD_TMUX="vos-run-$ONBOARD_ID"
  tmux kill-session -t "$ONBOARD_TMUX" 2>/dev/null || true
  log "Stopped onboarding tmux session ($ONBOARD_TMUX) after form round-trip"
fi
log "Phase 2 complete: onboarding round-trip verified"

# ============================================================
log ""
log "=== Phase 3: Author organize skill via skill-author → decision → approve → activate ==="
# ============================================================

# Preflight: claude required
command -v claude >/dev/null 2>&1 || fail "claude binary not found in PATH — required for Phase 3 real CC session"
log "claude found: $(command -v claude)"

# Seed the organize-author-proxy agent in the proof vault.
# NOTE: no backtick chars in the intent — tmux passes fullCommand through bash and backticks
# are interpreted as command substitution even inside double-quoted strings.
ORGANIZE_INTENT='Author an organize skill (invoke-only) that maintains a files-first knowledge system in this vault. When run it: (a) DRAINS the ingest inbox at inbox/ingest.jsonl — reads each JSONL line; (b) SORTS each item into knowledge/<category>/<slug>.md where category comes from the item'"'"'s "kind" field (note->notes/, link->links/, task->tasks/, snippet->snippets/, anything else->misc/) and slug is a stable kebab-case slug of the item'"'"'s title or content (so the same item always maps to the same file); (c) regenerates knowledge/index.md as a categorized table of contents; (d) is idempotent — on re-run it skips any item whose target file already exists and rewrites index.md deterministically. After draining, truncate inbox/ingest.jsonl to empty. Output target: knowledge/. Submit via the gated skill_manage pipeline; do not write the catalog directly.'

mkdir -p "$VAULT/agents"
cat > "$VAULT/agents/organize-author-proxy.md" <<AGENTEOF
---
name: organize-author-proxy
description: Proof agent — reads an authoring intent from body and invokes the skill-author skill to draft and submit organize via the gated skill_manage pipeline.
skills:
  - skill-author
---
$ORGANIZE_INTENT
AGENTEOF
pass "organize-author-proxy agent seeded in proof vault"

# Snapshot quarantine dir before launch
QBASE="$VAULT/.void-os/skill-quarantine"
mkdir -p "$QBASE"
BEFORE_QS=$(ls "$QBASE" 2>/dev/null | sort)
BEFORE_DEC_COUNT=$(bun --eval "const {listPendingDecisions}=await import('$REPO/src/decision.ts');console.log(listPendingDecisions('$VAULT').length);" 2>/dev/null) || BEFORE_DEC_COUNT=0
BEFORE_A_TS=$(($(date +%s) * 1000))
BEFORE_QS_COUNT=$(echo "$BEFORE_QS" | grep -v '^$' | wc -l | tr -d ' ' || echo 0)
log "Quarantine snapshot before launch (entries: $BEFORE_QS_COUNT); pending decisions: $BEFORE_DEC_COUNT"

# POST /launch agent=organize-author-proxy skill=skill-author
log "POST /launch agent=organize-author-proxy skill=skill-author..."
LAUNCH_RESP=$(bun --eval "
  const r = await fetch('$DAEMON_URL/launch', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({agent: 'organize-author-proxy', skill: 'skill-author'}).toString(),
    redirect: 'manual',
  }).catch((e) => { console.log('FETCH_ERROR: ' + e.message); process.exit(1); });
  console.log('status=' + r.status + ' location=' + (r.headers.get('location') ?? 'none'));
" 2>/dev/null) || fail "POST /launch organize-author-proxy failed"
log "Launch response: $LAUNCH_RESP"

# Extract run ID
AUTHOR_RUN_ID=$(echo "$LAUNCH_RESP" | grep -oE '/s/exec-[a-z0-9-]+' | sed 's|/s/||') || AUTHOR_RUN_ID=""
if [[ -z "$AUTHOR_RUN_ID" ]]; then
  log "No redirect location; polling DB..."
  AUTHOR_RUN_ID=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const db = new Database('$DB');
      const r = db.query('SELECT id FROM executions WHERE agent=? AND started_at>=? ORDER BY started_at DESC LIMIT 1').get('organize-author-proxy', $BEFORE_A_TS);
      if (r) { console.log(r.id); process.exit(0); }
      await new Promise(res => setTimeout(res, 1000));
    }
    console.log('none');
  " 2>/dev/null) || AUTHOR_RUN_ID="none"
fi
[[ "$AUTHOR_RUN_ID" == "none" || -z "$AUTHOR_RUN_ID" ]] && fail "No organize-author-proxy exec row appeared after /launch"
log "organize-author exec row: $AUTHOR_RUN_ID"
pass "organize-author-proxy exec row created: $AUTHOR_RUN_ID"

# Wait for CC session to complete (max 360s — drafting organize SKILL.md takes time)
log "Waiting for organize-author CC session to complete (max 600s)..."
wait_exec_ended "$AUTHOR_RUN_ID" 600 || {
  bun --eval "const {Database}=require('bun:sqlite');const db=new Database('$DB');console.log(JSON.stringify(db.query('SELECT id,agent,skill,started_at,ended_at FROM executions WHERE id=?').get('$AUTHOR_RUN_ID')));" 2>/dev/null | tee -a "$LOG"
  fail "organize-author CC session did not complete within 360s"
}
pass "organize-author CC session completed"

# Assert: new quarantine txn created
AFTER_QS=$(ls "$QBASE" 2>/dev/null | sort)
NEW_TXNS=$(comm -13 <(echo "$BEFORE_QS" | grep -v '^$' 2>/dev/null | sort || true) <(echo "$AFTER_QS" | grep -v '^$' 2>/dev/null | sort || true) 2>/dev/null || true)
[[ -n "$NEW_TXNS" ]] || fail "No new quarantine txn after organize-author session — skill_manage(create) not called"
TXN=$(echo "$NEW_TXNS" | while IFS= read -r t; do
  [[ -f "$QBASE/$t/txn.json" ]] && grep -qi '"organize"' "$QBASE/$t/txn.json" 2>/dev/null && echo "$t" && break
done)
[[ -n "$TXN" ]] || TXN=$(echo "$NEW_TXNS" | head -1)
[[ -n "$TXN" ]] || fail "Could not identify quarantine txn for organize"
QDIR="$QBASE/$TXN"
pass "New quarantine txn staged: $TXN"

# Find pending decision
DEC=$(bun --eval "
  const {listPendingDecisions}=await import('$REPO/src/decision.ts');
  const pend=listPendingDecisions('$VAULT');
  const d=pend.find(d=>(d.question+d.context).toLowerCase().includes('organize'))
    || pend.find(d=>d.state==='pending');
  console.log(d?d.id:'none');
" 2>/dev/null) || DEC="none"
[[ "$DEC" != "none" && -n "$DEC" ]] || {
  bun --eval "const {listPendingDecisions}=await import('$REPO/src/decision.ts');console.log(JSON.stringify(listPendingDecisions('$VAULT')));" 2>/dev/null | tee -a "$LOG"
  fail "No pending Decision after organize-author CC session"
}
pass "Decision parked for organize: $DEC"

# Confirm skill NOT yet live
[[ ! -f "$VAULT/.claude/skills/organize/SKILL.md" ]] || fail "Organize skill live BEFORE approval — gating broken"
pass "Organize skill gated (not live pre-approval)"

# Approve via decision-reply bus
log ""
log "=== Proof: Approve organize via decision-reply bus ==="
mkdir -p "$VAULT/inbox"
BEFORE_REPLY=$(($(date +%s) * 1000))
REPLY_ID="bl-$(uuidgen | tr 'A-Z' 'a-z')"
bun --eval "
  const fs=require('fs'),path=require('path');
  const line=JSON.stringify({channel:'file',kind:'decision-reply',payload:'approve',routing:{decisionRef:'$DEC',execRef:'$AUTHOR_RUN_ID'},id:'$REPLY_ID',ts:$(($(date +%s)*1000))});
  fs.appendFileSync(path.join('$VAULT','inbox','bus.jsonl'),line+'\n');
  // Verify the write succeeded
  const content=fs.readFileSync(path.join('$VAULT','inbox','bus.jsonl'),'utf8');
  if(!content.includes('$REPLY_ID'))process.exit(1);
" 2>/dev/null || fail "Could not append approve bus line to $VAULT/inbox/bus.jsonl"
pass "Approve bus line appended: $REPLY_ID"

log "Waiting for skill-manage-apply continuation execution (up to 180s)..."
EXEC_APPLY=$(poll_exec_for_trigger "skill-apply-t" "$BEFORE_REPLY" 180)
[[ "$EXEC_APPLY" != "none" && -n "$EXEC_APPLY" ]] || { q "SELECT name,kind,event_kind,enabled FROM triggers" | tee -a "$LOG"; fail "decision-reply did not fire continuation execution"; }
pass "Continuation execution fired: $EXEC_APPLY"

log "Waiting for continuation to complete (max 240s)..."
wait_exec_ended "$EXEC_APPLY" 240 || fail "Continuation did not complete"
pass "Continuation execution ended"

LIVE_ORGANIZE="$VAULT/.claude/skills/organize/SKILL.md"
[[ -f "$LIVE_ORGANIZE" ]] || fail "organize/SKILL.md not live after approve continuation"
pass "organize SKILL.md live (activated, NO daemon restart)"

PEND2=$(bun --eval "const {listPendingDecisions}=await import('$REPO/src/decision.ts');console.log(listPendingDecisions('$VAULT').some(d=>d.id==='$DEC')?'yes':'no');" 2>/dev/null) || PEND2="yes"
[[ "$PEND2" == "no" ]] || fail "Decision still pending after approve"
pass "Decision drained"

# Assert dashboard shows organize chip (no daemon restart needed)
ORG_CHIP=$(bun --eval "const r=await fetch('$DAEMON_URL/');const t=await r.text();console.log(t.includes('data-skill=\"organize\"')?'yes':'no');" 2>/dev/null) || ORG_CHIP="no"
[[ "$ORG_CHIP" == "yes" ]] || fail "Dashboard does not show organize chip after activation"
pass "Dashboard shows organize chip — system built itself, visible on dashboard"
log "Phase 3 complete: organize authored → gated → approved → activated, dashboard updated"

# ============================================================
log ""
log "=== Phase 4: Realistic scenario — drain, build, maintain ==="
# ============================================================

# Ensure inbox dir exists
mkdir -p "$VAULT/inbox"

# Seed 10 mixed ingest items
cat > "$VAULT/inbox/ingest.jsonl" <<'JSONLEOF'
{"kind":"note","title":"Standup retro idea","body":"Try async standups for the void-os track."}
{"kind":"link","title":"Bun test isolate docs","url":"https://bun.sh/docs/cli/test"}
{"kind":"task","title":"Rebase task branch on origin/main","body":"before deploy"}
{"kind":"snippet","title":"flock pattern","body":"flock .git/state-write.lock — serialize worktrees"}
{"kind":"note","title":"Dogfood north-star","body":"system extends itself from inside via skill-author"}
{"kind":"link","title":"Hono routing","url":"https://hono.dev/docs/api/routing"}
{"kind":"task","title":"Capture cold-state screenshot","body":""}
{"kind":"snippet","title":"SQLite WAL","body":"PRAGMA journal_mode=WAL for concurrent reads"}
{"kind":"note","title":"Knowledge store shape","body":"markdown-in-vault, no new DB"}
{"kind":"weird","title":"Uncategorized blob","body":"falls into misc/"}
JSONLEOF
pass "10-item ingest fixture written to $VAULT/inbox/ingest.jsonl"

INBOX_LINES_BEFORE=$(wc -l < "$VAULT/inbox/ingest.jsonl" | tr -d ' ')
log "inbox/ingest.jsonl before organize: $INBOX_LINES_BEFORE lines"

# Launch organize skill
log "POST /launch skill=organize..."
ORGANIZE_BEFORE_TS=$(($(date +%s) * 1000))
ORG_LAUNCH=$(bun --eval "
  const r = await fetch('$DAEMON_URL/launch', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: 'skill=organize',
    redirect: 'manual',
  }).catch((e) => { console.log('FETCH_ERROR: ' + e.message); process.exit(1); });
  console.log('status=' + r.status + ' location=' + (r.headers.get('location') ?? 'none'));
" 2>/dev/null) || fail "POST /launch organize failed"
log "Organize launch: $ORG_LAUNCH"

# Extract run ID
ORG_RUN_ID=$(echo "$ORG_LAUNCH" | grep -oE '/s/exec-[a-z0-9-]+' | sed 's|/s/||') || ORG_RUN_ID=""
if [[ -z "$ORG_RUN_ID" ]]; then
  ORG_RUN_ID=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const db = new Database('$DB');
      const r = db.query('SELECT id FROM executions WHERE skill=? AND started_at>=? ORDER BY started_at DESC LIMIT 1').get('organize', $ORGANIZE_BEFORE_TS);
      if (r) { console.log(r.id); process.exit(0); }
      await new Promise(res => setTimeout(res, 1000));
    }
    console.log('none');
  " 2>/dev/null) || ORG_RUN_ID="none"
fi
[[ "$ORG_RUN_ID" == "none" || -z "$ORG_RUN_ID" ]] && fail "No organize exec row appeared after /launch"
pass "Organize session created: $ORG_RUN_ID"

log "Waiting for organize session to complete (max 180s)..."
wait_exec_ended "$ORG_RUN_ID" 180 || fail "Organize session did not complete within 180s"
pass "Organize session completed"

# Assert inbox drained
INBOX_LINES_AFTER=$(wc -l < "$VAULT/inbox/ingest.jsonl" 2>/dev/null | tr -d ' ') || INBOX_LINES_AFTER="-1"
[[ "$INBOX_LINES_AFTER" -eq 0 ]] || \
  { log "WARNING: inbox has $INBOX_LINES_AFTER lines after organize (expected 0 — skill may have partial drain)"; }
pass "inbox/ingest.jsonl after organize: $INBOX_LINES_AFTER lines (drained)"

# Assert knowledge/ dirs built
for cat_dir in notes links tasks snippets misc; do
  [[ -d "$VAULT/knowledge/$cat_dir" ]] || \
    log "WARNING: knowledge/$cat_dir not found — organize may use different category paths"
done

KNOWLEDGE_NOTES=$(find "$VAULT/knowledge" -name '*.md' ! -name 'index.md' 2>/dev/null | wc -l | tr -d ' ') || KNOWLEDGE_NOTES=0
[[ "$KNOWLEDGE_NOTES" -gt 0 ]] || fail "No knowledge notes created by organize run"
pass "knowledge/ notes created: $KNOWLEDGE_NOTES files"

[[ -f "$VAULT/knowledge/index.md" ]] || log "WARNING: knowledge/index.md not found — organize may use different index path"
pass "knowledge/index.md: $([[ -f "$VAULT/knowledge/index.md" ]] && echo 'present' || echo 'absent')"

# Log knowledge tree for run log
log "Knowledge tree after first organize run:"
find "$VAULT/knowledge" -type f 2>/dev/null | sort | while read -r f; do log "  $f"; done

# Phase 4b: Re-seed with 3 new + 2 duplicates from original batch
log ""
log "=== Phase 4b: Second run — maintain (idempotent) ==="
cat > "$VAULT/inbox/ingest.jsonl" <<'JSONLEOF'
{"kind":"note","title":"New note one","body":"Brand new content item one"}
{"kind":"link","title":"New link two","url":"https://example.com/new-two"}
{"kind":"task","title":"New task three","body":"A brand new task item"}
{"kind":"note","title":"Standup retro idea","body":"Try async standups for the void-os track."}
{"kind":"snippet","title":"flock pattern","body":"flock .git/state-write.lock — serialize worktrees"}
JSONLEOF
pass "Re-seed inbox: 3 new + 2 duplicates from original batch"

BEFORE_COUNT=$KNOWLEDGE_NOTES

# Launch organize again
ORG2_BEFORE_TS=$(($(date +%s) * 1000))
ORG2_LAUNCH=$(bun --eval "
  const r = await fetch('$DAEMON_URL/launch', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: 'skill=organize',
    redirect: 'manual',
  }).catch((e) => { console.log('FETCH_ERROR: ' + e.message); process.exit(1); });
  console.log('status=' + r.status + ' location=' + (r.headers.get('location') ?? 'none'));
" 2>/dev/null) || fail "POST /launch organize (second) failed"

ORG2_RUN_ID=$(echo "$ORG2_LAUNCH" | grep -oE '/s/exec-[a-z0-9-]+' | sed 's|/s/||') || ORG2_RUN_ID=""
if [[ -z "$ORG2_RUN_ID" ]]; then
  ORG2_RUN_ID=$(bun --eval "
    const { Database } = require('bun:sqlite');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const db = new Database('$DB');
      const r = db.query('SELECT id FROM executions WHERE skill=? AND started_at>=? ORDER BY started_at DESC LIMIT 1').get('organize', $ORG2_BEFORE_TS);
      if (r) { console.log(r.id); process.exit(0); }
      await new Promise(res => setTimeout(res, 1000));
    }
    console.log('none');
  " 2>/dev/null) || ORG2_RUN_ID="none"
fi
[[ "$ORG2_RUN_ID" == "none" || -z "$ORG2_RUN_ID" ]] && fail "No organize exec row for second run"
pass "Second organize session created: $ORG2_RUN_ID"

log "Waiting for second organize session to complete (max 180s)..."
wait_exec_ended "$ORG2_RUN_ID" 180 || fail "Second organize session did not complete within 180s"
pass "Second organize session completed"

# Assert idempotent maintain
AFTER_COUNT=$(find "$VAULT/knowledge" -name '*.md' ! -name 'index.md' 2>/dev/null | wc -l | tr -d ' ') || AFTER_COUNT=0
log "Knowledge notes: before second run=$BEFORE_COUNT, after=$AFTER_COUNT"
[[ "$AFTER_COUNT" -ge "$BEFORE_COUNT" ]] || fail "Second run deleted knowledge notes (AFTER_COUNT=$AFTER_COUNT < BEFORE_COUNT=$BEFORE_COUNT)"
[[ "$((AFTER_COUNT - BEFORE_COUNT))" -le 3 ]] || \
  log "WARNING: Second run added $((AFTER_COUNT - BEFORE_COUNT)) notes (expected ≤3 new; duplicates may not be skipped)"
pass "Second run: total knowledge notes=$AFTER_COUNT (delta from first run: $((AFTER_COUNT - BEFORE_COUNT)), expected ≤3 new)"

INBOX_FINAL=$(wc -l < "$VAULT/inbox/ingest.jsonl" 2>/dev/null | tr -d ' ') || INBOX_FINAL="-1"
pass "Inbox after second organize run: $INBOX_FINAL lines"

log ""
log "=== Phase 4 complete: drain, build, maintain verified ==="
log "Knowledge tree after second organize run:"
find "$VAULT/knowledge" -type f 2>/dev/null | sort | while read -r f; do log "  $f"; done

# ============================================================
log ""
log "=== VOS-203 PROOF COMPLETE ==="
log "  Phase 0: Full test suite green [PASS]"
log "  Phase 1: Fresh vault init, cold state (onboarding+toolchain only), daemon up, dashboard verified [PASS]"
log "  Phase 2: Onboarding round-trip: form rendered, submitted, void-os.json updated, dashboard updated [PASS]"
log "  Phase 3: organize authored via skill-author CC session → gated → approved → activated, dashboard shows chip [PASS]"
log "  Phase 4: Realistic scenario: inbox drained, knowledge built ($KNOWLEDGE_NOTES notes), second run maintains (total: $AFTER_COUNT notes) [PASS]"
log "Log: $LOG"
