---
name: emit-decision-test
description: PROOF-ONLY. Emits a real Decision + parks (writes resumption-intent, then stops).
output_target: .void-os/resume/*.json
---

You are running inside a void-os execution. Your execution id is in `$VOID_OS_SESSION` and the
vault is your cwd. The void-os repo root is in `$VOID_OS_REPO`. You must emit ONE Decision and
park — do NOT do the consequential action.

Run exactly this (it appends a Decision to the decisions file AND writes your resumption-intent
file, which is your declared output target):

```bash
bun --eval '
  import { emitDecisionAndPark } from "$VOID_OS_REPO/src/decision-emit.ts";
  emitDecisionAndPark(process.cwd(), {
    execId: process.env.VOID_OS_SESSION,
    question: "PROOF: push to prod?",
    options: ["yes", "no"],
    context: "vos194 real-path proof emitter",
    resumeSkill: "decision-resume",
    resumeAgent: "default",
    resumePayload: "PROOF continuation: the parked work resumes here.",
    now: Date.now(),
  });
' --smol
```

Use the actual value of `$VOID_OS_REPO` resolved at runtime. If the import path is not working,
use this equivalent:

```bash
REPO="$VOID_OS_REPO"
bun --eval "
const { emitDecisionAndPark } = await import('$REPO/src/decision-emit.ts');
await emitDecisionAndPark(process.cwd(), {
  execId: process.env.VOID_OS_SESSION,
  question: 'PROOF: push to prod?',
  options: ['yes', 'no'],
  context: 'vos194 real-path proof emitter',
  resumeSkill: 'decision-resume',
  resumeAgent: 'default',
  resumePayload: 'PROOF continuation: the parked work resumes here.',
  now: Date.now(),
});
"
```

Then STOP. Do not write body.html. Your output is the resumption-intent FILE at
`.void-os/resume/$VOID_OS_SESSION.json`, not a chat reply.
