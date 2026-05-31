// tests/fixtures/fake-skill.ts — pretends to be a drainable skill (vc).
// It ONLY edits a file in CWD (the worktree) + writes body.html (presentation).
// It does NOT run the gate, check a box, commit, or write any signal. The RUNNER
// runs the gate after this exits — proving the runner-owned-gate architecture.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const uuid = process.env.VOID_OS_SESSION!;
const vault = process.env.VOID_OS_VAULT ?? join(process.env.HOME ?? "/tmp", ".void-os");
mkdirSync(join(vault, "sessions", uuid), { recursive: true });
writeFileSync(join(vault, "sessions", uuid, "body.html"), "<h1>fake skill worked a box</h1>");
// Make a real edit in CWD (the worktree) — the runner will `git add -A && commit` it on a green gate.
writeFileSync(join(process.cwd(), `box-${uuid}.txt`), "work output");
