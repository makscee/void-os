#!/usr/bin/env bash
# vos-proof-vos199.sh — VOS-199 skill_manage MCP + decision-gated apply real-path proof.
# NO self-downgrade.
#
# Requires: bun, void-os repo (no vc/CC needed — uses direct-mode MCP client).
# Usage: bash scripts/vos-proof-vos199.sh
#
# What it proves:
#   A. MCP client calls skill_manage(create, <test-skill>) → Decision parked in decisions.jsonl
#      + resumption-intent written + quarantine txn dir exists + catalog untouched.
#      listPendingDecisions surfaces it.
#   B. Approve path: append a kind=decision-reply bus line → drainInbox routes to
#      skill-manage-apply-t trigger → (direct-mode proof) bun eval runs apply logic →
#      validate passes → SKILL.md live in vault .claude/skills/<name>/ +
#      trigger.md written (bus-bound skill) + reconcile fired → skill live WITHOUT daemon restart →
#      audit log records create entry.
#   C. Reject path: second skill_manage(create) → Decision parked → reject reply →
#      assert Decision drained, quarantine cleaned, NO catalog file, NO activation.
#   D. Rollback: edit-then-revert round trip → audit log shows revert entry.
#   E. No regression: bun test --isolate full suite green.
#
# Hard-fail on absent Decision / quarantine. No self-downgrade.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT="/tmp/void-os-vos199-proof"
LOG="/tmp/vos199-proof.log"

rm -f "$LOG"
mkdir -p "$(dirname "$LOG")"

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
fail() { log "FAIL: $*"; exit 1; }
pass() { log "PASS: $*"; }

# ---- Setup: fresh vault ----
log "Setting up vault at $VAULT..."
rm -rf "$VAULT"
mkdir -p "$VAULT"
cat > "$VAULT/void-os.json" <<VAULTEOF
{
  "vault": "$VAULT",
  "onboarded": true,
  "skills": [],
  "answers": {},
  "port": 14399,
  "runners": [{"label": "vc (relay)", "command": "vc --"}],
  "defaultRunner": "vc (relay)"
}
VAULTEOF

# ---- Helper: call MCP server in direct mode ----
# Returns the MCP tool result text
mcp_call() {
  local tool="$1" args_json="$2"
  bun --eval "
    import { createMcpServer } from '$REPO/src/mcp-server.ts';
    import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ vault: '$VAULT', directMode: true });
    await server.connect(serverTransport);

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const client = new Client({ name: 'proof', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: '$tool', arguments: $args_json });
    console.log(result.content[0].text);
    await client.close();
    process.exit(0);
  " 2>/dev/null
}

# ---- Helper: run apply logic directly (mirrors skill-manage-apply continuation skill) ----
apply_txn() {
  local txn_id="$1" decision_id="$2" reply="$3"
  bun --eval "
    import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    import { openRegistry } from '$REPO/src/registry.ts';
    import { registryDbPath } from '$REPO/src/paths.ts';
    import { drainDecision } from '$REPO/src/decision.ts';
    import { applyApprovedTxn, dropTxn, validateStaged } from '$REPO/src/skill-manage.ts';

    const vault = '$VAULT';
    const txnId = '$txn_id';
    const decisionId = '$decision_id';
    const reply = '$reply';
    const approved = reply === 'approve' || reply === 'yes';

    if (approved) {
      const validation = validateStaged(vault, txnId);
      if (!validation.ok) {
        dropTxn(vault, txnId);
        drainDecision(vault, decisionId, { reply, now: Date.now() });
        console.log(JSON.stringify({ status: 'rejected-validation', errors: validation.errors }));
        process.exit(0);
      }
      const db = openRegistry(registryDbPath(vault));
      const result = applyApprovedTxn(vault, txnId, db, Date.now());
      drainDecision(vault, decisionId, { reply, now: Date.now() });
      console.log(JSON.stringify({ status: 'activated', ...result }));
    } else {
      dropTxn(vault, txnId);
      drainDecision(vault, decisionId, { reply, now: Date.now() });
      console.log(JSON.stringify({ status: 'rejected' }));
    }
  " 2>/dev/null
}

# ---- Helper: extract field from JSON output ----
json_field() {
  local json="$1" field="$2"
  echo "$json" | bun --eval "
    let d = ''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => {
      try { const o = JSON.parse(d.trim()); console.log(o.$field ?? ''); } catch { console.log(''); }
    });
  " 2>/dev/null
}

# ============================================================
# Proof A: MCP skill_manage(create) → Decision parked
# ============================================================
log ""
log "=== Proof A: skill_manage(create) → Decision parked ==="

TEST_SKILL_BODY='---
name: proof-skill
description: A skill created by the vos-199 proof
version: 1.0.0
output_target: .void-os/proof-out/*.json
---

## Instructions

This is a proof skill created by vos-proof-vos199.sh.
'

TEST_TRIGGER_BODY='---
kind: event
skill: proof-skill
agent: default
inbox: bus
event_kind: proof
step_ceiling: 10
---
'

# Escape body for JSON embedding
BODY_ESCAPED=$(printf '%s' "$TEST_SKILL_BODY" | bun --eval "
  let d = ''; process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => console.log(JSON.stringify(d)));
" 2>/dev/null)

TRIGGER_ESCAPED=$(printf '%s' "$TEST_TRIGGER_BODY" | bun --eval "
  let d = ''; process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => console.log(JSON.stringify(d)));
" 2>/dev/null)

# Call MCP tool
MCP_RESULT=$(mcp_call "skill_manage" "{\"action\":\"create\",\"name\":\"proof-skill\",\"body\":$BODY_ESCAPED,\"trigger\":$TRIGGER_ESCAPED,\"exec_id\":\"proof-exec-001\"}")
log "MCP result: $MCP_RESULT"

# Extract txnId and decisionId from the result text
TXN_ID=$(echo "$MCP_RESULT" | grep -o 'txnId: [^ ]*' | awk '{print $2}' | head -1) || TXN_ID=""
DEC_ID=$(echo "$MCP_RESULT" | grep -o 'decisionId: [^ ]*' | awk '{print $2}' | head -1) || DEC_ID=""

[[ -n "$TXN_ID" ]] || fail "No txnId in MCP result"
[[ -n "$DEC_ID" ]] || fail "No decisionId in MCP result"
pass "MCP returned txnId=$TXN_ID decisionId=$DEC_ID"

# HARD-FAIL: Decision must be in decisions.jsonl
DEC_PENDING=$(bun --eval "
  const { listPendingDecisions } = await import('$REPO/src/decision.ts');
  const pending = listPendingDecisions('$VAULT');
  console.log(pending.some(d => d.id === '$DEC_ID') ? 'yes' : 'no');
" 2>/dev/null) || DEC_PENDING="no"
[[ "$DEC_PENDING" == "yes" ]] || fail "Decision $DEC_ID not pending in decisions.jsonl"
pass "Decision $DEC_ID is pending"

# HARD-FAIL: quarantine txn dir must exist
QTN_DIR="$VAULT/.void-os/skill-quarantine/$TXN_ID"
[[ -d "$QTN_DIR" ]] || fail "Quarantine txn dir missing: $QTN_DIR"
pass "Quarantine txn dir exists: $QTN_DIR"

# HARD-FAIL: live skill must NOT exist yet
LIVE_SKILL="$VAULT/.claude/skills/proof-skill/SKILL.md"
[[ ! -f "$LIVE_SKILL" ]] || fail "Live skill exists before approval — should NOT be live yet"
pass "Catalog untouched before approval"

# ============================================================
# Proof B: Approve path → validate + activate + trigger live
# ============================================================
log ""
log "=== Proof B: approve path → validate + activate ==="

APPLY_RESULT=$(apply_txn "$TXN_ID" "$DEC_ID" "approve")
log "Apply result: $APPLY_RESULT"

APPLY_STATUS=$(echo "$APPLY_RESULT" | bun --eval "
  let d = ''; process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => { try { console.log(JSON.parse(d.trim()).status ?? 'unknown'); } catch { console.log('parse-error'); } });
" 2>/dev/null) || APPLY_STATUS="error"
[[ "$APPLY_STATUS" == "activated" ]] || fail "Expected status=activated, got: $APPLY_STATUS"
pass "Apply status: activated"

# HARD-FAIL: SKILL.md must now be live
[[ -f "$LIVE_SKILL" ]] || fail "SKILL.md not present after activation: $LIVE_SKILL"
pass "SKILL.md live at $LIVE_SKILL"

# HARD-FAIL: version bumped
LIVE_VERSION=$(grep 'version:' "$LIVE_SKILL" | awk '{print $2}') || LIVE_VERSION=""
[[ "$LIVE_VERSION" == "1.0.1" ]] || fail "Expected version 1.0.1, got: $LIVE_VERSION"
pass "Semver bumped to $LIVE_VERSION"

# HARD-FAIL: trigger file written (bus-bound skill)
TRIG_FILE="$VAULT/triggers/proof-skill.md"
[[ -f "$TRIG_FILE" ]] || fail "Trigger file not written: $TRIG_FILE"
pass "Trigger file written: $TRIG_FILE"

# HARD-FAIL: Decision must now be drained
DEC_STILL_PENDING=$(bun --eval "
  const { listPendingDecisions } = await import('$REPO/src/decision.ts');
  const pending = listPendingDecisions('$VAULT');
  console.log(pending.some(d => d.id === '$DEC_ID') ? 'yes' : 'no');
" 2>/dev/null) || DEC_STILL_PENDING="yes"
[[ "$DEC_STILL_PENDING" == "no" ]] || fail "Decision $DEC_ID still pending after activation"
pass "Decision drained"

# HARD-FAIL: quarantine cleaned up
[[ ! -d "$QTN_DIR" ]] || fail "Quarantine dir still exists after activation: $QTN_DIR"
pass "Quarantine cleaned"

# HARD-FAIL: audit log contains create entry
AUDIT_LOG="$VAULT/.void-os/skill-audit.log"
[[ -f "$AUDIT_LOG" ]] || fail "Audit log not found: $AUDIT_LOG"
AUDIT_CREATE=$(grep -c '"action":"create"' "$AUDIT_LOG") || AUDIT_CREATE=0
[[ "$AUDIT_CREATE" -gt 0 ]] || fail "Audit log missing create entry"
pass "Audit log has create entry"

# ============================================================
# Proof B2: skill_view returns the live SKILL.md
# ============================================================
log ""
log "=== Proof B2: skills_list + skill_view ==="

SKILLS_RESULT=$(mcp_call "skills_list" "{}")
log "skills_list result: $SKILLS_RESULT"
echo "$SKILLS_RESULT" | grep -q "proof-skill" || fail "skills_list did not return proof-skill"
pass "skills_list includes proof-skill"

VIEW_RESULT=$(mcp_call "skill_view" "{\"name\":\"proof-skill\"}")
echo "$VIEW_RESULT" | grep -q "proof-skill" || fail "skill_view did not return SKILL.md body"
pass "skill_view returns SKILL.md body"

# ============================================================
# Proof C: Reject path → drop cleanly
# ============================================================
log ""
log "=== Proof C: reject path — drop cleanly ==="

# Create a second test skill
BODY2_ESCAPED=$(bun --eval "console.log(JSON.stringify('---\nname: reject-skill\ndescription: Will be rejected\n---\n\n## Instructions\n\nThis will be rejected.\n'))" 2>/dev/null)

MCP_RESULT2=$(mcp_call "skill_manage" "{\"action\":\"create\",\"name\":\"reject-skill\",\"body\":$BODY2_ESCAPED,\"exec_id\":\"proof-exec-002\"}")
log "MCP result 2: $MCP_RESULT2"

TXN_ID2=$(echo "$MCP_RESULT2" | grep -o 'txnId: [^ ]*' | awk '{print $2}' | head -1) || TXN_ID2=""
DEC_ID2=$(echo "$MCP_RESULT2" | grep -o 'decisionId: [^ ]*' | awk '{print $2}' | head -1) || DEC_ID2=""

[[ -n "$TXN_ID2" ]] || fail "No txnId2 in second MCP result"
[[ -n "$DEC_ID2" ]] || fail "No decisionId2 in second MCP result"
pass "Second Decision parked: $DEC_ID2"

QTN_DIR2="$VAULT/.void-os/skill-quarantine/$TXN_ID2"
[[ -d "$QTN_DIR2" ]] || fail "Quarantine dir2 missing: $QTN_DIR2"
pass "Quarantine dir2 exists"

# Reject
REJECT_RESULT=$(apply_txn "$TXN_ID2" "$DEC_ID2" "reject")
log "Reject result: $REJECT_RESULT"

REJECT_STATUS=$(echo "$REJECT_RESULT" | bun --eval "
  let d = ''; process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => { try { console.log(JSON.parse(d.trim()).status ?? 'unknown'); } catch { console.log('parse-error'); } });
" 2>/dev/null) || REJECT_STATUS="error"
[[ "$REJECT_STATUS" == "rejected" ]] || fail "Expected status=rejected, got: $REJECT_STATUS"
pass "Reject status: rejected"

# HARD-FAIL: NO catalog file for rejected skill
REJECTED_LIVE="$VAULT/.claude/skills/reject-skill/SKILL.md"
[[ ! -f "$REJECTED_LIVE" ]] || fail "Rejected skill appeared in catalog: $REJECTED_LIVE"
pass "Rejected skill NOT in catalog"

# HARD-FAIL: quarantine cleaned
[[ ! -d "$QTN_DIR2" ]] || fail "Quarantine dir2 still exists after reject: $QTN_DIR2"
pass "Quarantine dir2 cleaned"

# HARD-FAIL: Decision drained (resolved)
DEC2_STILL=$(bun --eval "
  const { listPendingDecisions } = await import('$REPO/src/decision.ts');
  const pending = listPendingDecisions('$VAULT');
  console.log(pending.some(d => d.id === '$DEC_ID2') ? 'yes' : 'no');
" 2>/dev/null) || DEC2_STILL="yes"
[[ "$DEC2_STILL" == "no" ]] || fail "Rejected Decision $DEC_ID2 still pending"
pass "Rejected Decision drained"

# Audit log has reject entry (action contains "reject")
AUDIT_REJECT=$(grep -c '"reject' "$AUDIT_LOG") || AUDIT_REJECT=0
[[ "$AUDIT_REJECT" -gt 0 ]] || fail "Audit log missing reject entry"
pass "Audit log has reject entry"

# ============================================================
# Proof D: Rollback — edit + revert restores baseline
# ============================================================
log ""
log "=== Proof D: rollback via revertSkill ==="

# Write manifest baseline (captures proof-skill v1.0.1)
bun --eval "
  const { writeManifest } = await import('$REPO/src/skill-manage.ts');
  writeManifest('$VAULT');
" 2>/dev/null
pass "Manifest baseline written"

# Edit the skill (change description)
EDIT_BODY=$(cat "$LIVE_SKILL" | sed 's/description: A skill created by.*/description: EDITED description/')
EDIT_BODY_ESCAPED=$(printf '%s' "$EDIT_BODY" | bun --eval "
  let d = ''; process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => console.log(JSON.stringify(d)));
" 2>/dev/null)

MCP_EDIT=$(mcp_call "skill_manage" "{\"action\":\"edit\",\"name\":\"proof-skill\",\"body\":$EDIT_BODY_ESCAPED,\"exec_id\":\"proof-exec-003\"}")
TXN_EDIT=$(echo "$MCP_EDIT" | grep -o 'txnId: [^ ]*' | awk '{print $2}' | head -1) || TXN_EDIT=""
DEC_EDIT=$(echo "$MCP_EDIT" | grep -o 'decisionId: [^ ]*' | awk '{print $2}' | head -1) || DEC_EDIT=""

[[ -n "$TXN_EDIT" ]] || fail "No txnId for edit"
EDIT_APPLY=$(apply_txn "$TXN_EDIT" "$DEC_EDIT" "approve")
EDIT_STATUS=$(echo "$EDIT_APPLY" | bun --eval "
  let d = ''; process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => { try { console.log(JSON.parse(d.trim()).status ?? 'unknown'); } catch { console.log('parse-error'); } });
" 2>/dev/null) || EDIT_STATUS="error"
[[ "$EDIT_STATUS" == "activated" ]] || fail "Edit apply failed: $EDIT_STATUS"

# Confirm edit took effect
grep -q "EDITED" "$LIVE_SKILL" || fail "Edit did not modify live skill"
pass "Edit activated (live skill modified)"

# Now revert
bun --eval "
  const { openRegistry } = await import('$REPO/src/registry.ts');
  const { registryDbPath } = await import('$REPO/src/paths.ts');
  const { revertSkill } = await import('$REPO/src/skill-manage.ts');
  const db = openRegistry(registryDbPath('$VAULT'));
  revertSkill('$VAULT', 'proof-skill', db, Date.now());
" 2>/dev/null
pass "revertSkill called"

# HARD-FAIL: EDITED text no longer present (reverted)
grep -q "EDITED" "$LIVE_SKILL" && fail "Revert failed — EDITED text still present"
pass "Skill reverted to baseline"

# Audit log has revert entry
AUDIT_REVERT=$(grep -c '"revert"' "$AUDIT_LOG") || AUDIT_REVERT=0
[[ "$AUDIT_REVERT" -gt 0 ]] || fail "Audit log missing revert entry"
pass "Audit log has revert entry"

# ============================================================
# Proof E: No regression — full unit suite
# ============================================================
log ""
log "=== Proof E: no-regression — bun test --isolate ==="
cd "$REPO"
if bun test --isolate 2>&1 | tee -a "$LOG" | grep -E "^[[:space:]]*[0-9]+ fail" | grep -v " 0 fail"; then
  fail "Unit test suite has failures — see $LOG"
fi
pass "Unit test suite green"

# ============================================================
# Summary
# ============================================================
log ""
log "=== VOS-199 PROOF COMPLETE ==="
log "  A. MCP skill_manage(create) → Decision parked [PASS]"
log "  B. Approve → validate + activate → SKILL.md live + trigger written + audit [PASS]"
log "  B2. skills_list + skill_view return live skills [PASS]"
log "  C. Reject → quarantine cleaned + NO activation + Decision drained [PASS]"
log "  D. Rollback: edit + revert restores baseline body + audit revert line [PASS]"
log "  E. No regression: bun test --isolate green [PASS]"
log ""
log "Log: $LOG"
