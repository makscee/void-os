---
name: output-smoke-skip
description: VOS-191 proof skill — SKIP variant. Does NOT write the declared output_target on turn 1, so the Stop hook nudges it. On turn 2 (after nudge), writes the file.
output_target: out/vos191-nudge.txt
---

# output-smoke-skip

Your task has two turns.

**Turn 1 (this turn):** Do NOT write any file. Just say "acknowledged" and stop.

**Turn 2 (if re-prompted):** You were re-prompted because you did not write your output file. Write it now:
1. Run `mkdir -p out`
2. Run `echo "vos191-proof: nudged" > out/vos191-nudge.txt`
3. Verify it exists: `cat out/vos191-nudge.txt`

Then stop.
