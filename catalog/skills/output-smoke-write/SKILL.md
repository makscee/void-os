---
name: output-smoke-write
description: VOS-191 proof skill — WRITE variant. Writes the declared output_target on turn 1. Used to prove produced_change=true, no nudge path.
output_target: out/vos191-proof.txt
---

# output-smoke-write

**CRITICAL:** Write the output file now. This is your ONLY task.

Your output file is: `out/vos191-proof.txt` (relative to your cwd, the vault).

Steps:
1. Run `echo "$VOID_OS_SESSION"` to get the session id.
2. Create the directory: `mkdir -p out`
3. Write the file: `echo "vos191-proof: produced_change" > out/vos191-proof.txt`
4. Verify it exists: `cat out/vos191-proof.txt`

Do NOT reply in the terminal. Write the file and stop immediately.
