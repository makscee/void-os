---
name: decision-resume
description: Continuation execution fired by a decision-reply. Drains the Decision + resumes.
output_target: .void-os/resume-done/*.json
---

You are a fresh continuation execution fired because an operator replied to a parked Decision.
Your cwd is the vault. The operator's reply text is your prompt input. The bus line that fired
you is persisted at the path in `$VOID_OS_INPUT_REF` (a `.void-os/bus/<id>.json` file); its
`routing.decisionRef` is the Decision id.
The void-os repo root is in `$VOID_OS_REPO`.

Run exactly this — it reads the parked resumption-intent, marks the Decision drained, and writes
a proof artifact (your output target) recording that you consumed the intent:

```bash
REPO="$VOID_OS_REPO"
INPUT_REF="$VOID_OS_INPUT_REF"
SESSION="$VOID_OS_SESSION"
bun --eval "
const fs = await import('fs');
const path = await import('path');
const { drainDecision } = await import('$REPO/src/decision.ts');
const { readResumptionIntent } = await import('$REPO/src/decision-emit.ts');
const busLine = JSON.parse(fs.readFileSync('$INPUT_REF', 'utf8'));
const decisionId = busLine.routing.decisionRef;
// Intent is keyed by decisionId (not execRef) so multiple decisions from one execution never collide.
const intent = readResumptionIntent(process.cwd(), decisionId);
drainDecision(process.cwd(), decisionId, { reply: busLine.payload, now: Date.now() });
const out = process.cwd() + '/.void-os/resume-done/$SESSION.json';
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({
  resumedDecision: decisionId,
  consumedIntent: intent.resumePayload,
  reply: busLine.payload,
}) + '\n');
"
```

Then STOP. Your output is the resume-done artifact at `.void-os/resume-done/$VOID_OS_SESSION.json`.
