---
name: skill-manage-apply
description: Continuation execution fired by a skill_manage decision-reply. Validates + activates (or drops) the staged skill txn.
output_target: .void-os/skill-apply-done/*.json
---

## Instructions

You are a continuation execution fired because an operator replied to a parked skill_manage Decision.
Your cwd is the vault. The operator's reply text is your prompt input. The bus line that fired
you is persisted at the path in `$VOID_OS_INPUT_REF` (a `.void-os/bus/<id>.json` file); its
`routing.decisionRef` is the Decision id.
The void-os repo root is in `$VOID_OS_REPO`.

Run exactly this — it reads the parked resumption-intent, checks the reply, validates + activates
(or drops) the staged txn, drains the Decision, and writes a proof artifact:

```bash
REPO="$VOID_OS_REPO"
INPUT_REF="$VOID_OS_INPUT_REF"
SESSION="$VOID_OS_SESSION"
VAULT="$(pwd)"
bun --eval "
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { drainDecision } from '$REPO/src/decision.ts';
import { readResumptionIntent } from '$REPO/src/decision-emit.ts';
import { openRegistry } from '$REPO/src/registry.ts';
import { registryDbPath } from '$REPO/src/paths.ts';
import { applyApprovedTxn, dropTxn, validateStaged } from '$REPO/src/skill-manage.ts';

const busLine = JSON.parse(readFileSync('$INPUT_REF', 'utf8'));
const decisionId = busLine.routing.decisionRef;
const vault = '$VAULT';
// Intent is keyed by decisionId (not execRef) so multiple decisions from one execution never collide.
const intent = readResumptionIntent(vault, decisionId);
const payload = JSON.parse(intent.resumePayload);
const { txnId } = payload;

const reply = String(busLine.payload ?? '').toLowerCase().trim();
const approved = reply === 'approve' || reply === 'yes' || reply === 'y';

let outcome;
if (approved) {
  const validation = validateStaged(vault, txnId);
  if (!validation.ok) {
    dropTxn(vault, txnId);
    drainDecision(vault, decisionId, { reply: busLine.payload, now: Date.now() });
    outcome = { status: 'rejected-validation-failed', errors: validation.errors, txnId, decisionId };
  } else {
    const db = openRegistry(registryDbPath(vault));
    const result = applyApprovedTxn(vault, txnId, db, Date.now());
    drainDecision(vault, decisionId, { reply: busLine.payload, now: Date.now() });
    outcome = { status: 'activated', txnId, decisionId, ...result };
  }
} else {
  dropTxn(vault, txnId);
  drainDecision(vault, decisionId, { reply: busLine.payload, now: Date.now() });
  outcome = { status: 'rejected', txnId, decisionId };
}

const out = vault + '/.void-os/skill-apply-done/' + '$SESSION' + '.json';
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  ...outcome,
  consumedIntent: intent.resumePayload,
  reply: busLine.payload,
}) + '\n');
console.log(JSON.stringify(outcome));
"
```

Then STOP. Your output is the skill-apply-done artifact at `.void-os/skill-apply-done/$VOID_OS_SESSION.json`.
