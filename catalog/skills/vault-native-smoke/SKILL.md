---
name: vault-native-smoke
description: VOS-197 proof skill — vault-native hand-launch smoke. Writes the declared output_target. Proves produced_change=true, no nudge path for hand-launched sessions.
output_target: out/vos197-proof.txt
---

# vault-native-smoke

**CRITICAL:** Write the output file now. This is your ONLY task.

Your output file is: `out/vos197-proof.txt` (relative to your cwd, the vault).

Steps:
1. Run `echo "$VOID_OS_SESSION"` to get the session id.
2. Create the directory: `mkdir -p out`
3. Write the file: `echo "vos197-proof: vault-native hand-launch" > out/vos197-proof.txt`
4. Verify it exists: `cat out/vos197-proof.txt`

Do NOT reply in the terminal. Write the file and stop immediately.
