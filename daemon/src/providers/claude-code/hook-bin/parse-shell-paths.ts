// VOS-106 T2: deliberately narrow shell-arg classifier for the PreToolUse
// hook's Bash gate. See spec §3.4 for the rule ordering.

export interface ShellPaths {
  reads: string[];
  writes: string[];
}

const NO_PATH_VERBS = new Set([
  "pwd", "echo", "date", "env", "hostname", "whoami", "true", "false",
]);

const READ_VERBS = new Set([
  "cat", "head", "tail", "less", "more", "ls", "grep", "rg", "find",
  "file", "stat", "wc",
]);

const WRITE_VERBS = new Set([
  "mv", "cp", "rm", "tee", "sed", "sd", "touch", "mkdir", "rmdir",
]);

// git subcommand → category. Anything else under git falls through to
// "unknown" and is conservatively denied if it carries a path.
const GIT_READ = new Set(["show", "log", "diff", "status", "blame"]);
const GIT_WRITE = new Set(["add", "mv", "rm", "commit", "checkout", "reset", "restore"]);

function looksLikePath(token: string): boolean {
  if (token.startsWith("-")) return false;
  if (token.includes("/")) return true;
  if (token.includes(".")) return true;
  return false;
}

/** Sentinel pushed when shell-substitution / parameter-expansion is detected.
 *  matchPath will never match this against any picomatch glob, so the hook's
 *  gate forces a deny. Picked deliberately unmatchable: no slashes, no glob
 *  meta, prefixed/suffixed with `__` to avoid collision with real paths. */
export const SHELL_SUBSTITUTION_SENTINEL = "__SHELL_SUBSTITUTION__";

/** VOS-106 T11.1: sentinel for shell meta-tokens (pipes, chains, input
 *  redirects, stderr/combined redirects). Same fail-closed pattern as
 *  SHELL_SUBSTITUTION_SENTINEL — we emit it into BOTH reads and writes so
 *  whichever gate the caller evaluates first will deny. Picked Option A
 *  (deny-on-meta) over Option B (split-and-recurse) for simplicity and
 *  zero recursion risk; precision loss on benign cases like `pwd | head`
 *  is acceptable since the hook's allow-list is intentionally narrow. */
export const SHELL_META_SENTINEL = "__SHELL_META__";

const SUBSTITUTION_RE = /\$\(|`|\$\{/;

// Meta-token detection. Order matters in the alternation only for readability;
// any single match short-circuits to the sentinel.
//   `\|`  pipe (also covers `||` since one match is enough)
//   `;`   command separator
//   `&&`  AND chain
//   `&>`  combined stdout+stderr redirect
//   `\d+>` numbered fd redirect, e.g. `2>` stderr — must precede bare `>` rule
//   `<`   input redirect (also matches heredoc `<<`)
// We deliberately do NOT match bare `>` / `>>` here — those are handled
// downstream as the existing redirect-target capture.
const META_RE = /\||;|&&|&>|\d+>|<|\|\|/;

export function parseShellPaths(cmd: string): ShellPaths {
  const reads: string[] = [];
  const writes: string[] = [];

  // VOS-106 security gate: shell substitution / parameter expansion bypasses
  // any literal-token analysis below (CC expands them client-side after the
  // hook decides). If any substitution syntax is present we short-circuit to
  // the sentinel — matchPath cannot allow it, hook denies. Loses precision
  // for benign cases (e.g. `echo $HOME`) but never silently allows a bypass.
  if (SUBSTITUTION_RE.test(cmd)) {
    return { reads: [SHELL_SUBSTITUTION_SENTINEL], writes: [] };
  }

  // VOS-106 T11.1 security gate: command chaining / pipes / non-stdout
  // redirects let a write-verb hide behind a read-verb (e.g. `cat x | tee y`
  // parses verb=cat and never sees tee). Fail-closed by emitting the meta
  // sentinel into both reads and writes — neither gate can match it.
  if (META_RE.test(cmd)) {
    return {
      reads: [SHELL_META_SENTINEL],
      writes: [SHELL_META_SENTINEL],
    };
  }

  // Split on whitespace, preserving redirect operators as their own tokens.
  // Naive tokenizer — agent prompts that need shell substitution / quoting
  // beyond this fall through to the conservative-deny branch below.
  const tokens = cmd
    .replace(/(>>|>)/g, " $1 ")
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return { reads, writes };

  // Redirect target capture: any `>` or `>>` token → next token is a write.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === ">" || tokens[i] === ">>") {
      const target = tokens[i + 1];
      if (target) writes.push(target);
    }
  }
  const argv = tokens.filter((t, i) => {
    if (t === ">" || t === ">>") return false;
    if (i > 0 && (tokens[i - 1] === ">" || tokens[i - 1] === ">>")) return false;
    return true;
  });

  const verb = argv[0] ?? "";
  const rest = argv.slice(1);

  if (NO_PATH_VERBS.has(verb)) return { reads, writes };

  if (verb === "git") {
    const sub = rest[0];
    const gitRest = rest.slice(1);
    if (!sub) return { reads, writes };
    if (sub === "status" && !gitRest.some((t) => t === "--")) {
      return { reads, writes };
    }
    const pathTokens = gitRest.filter(looksLikePath);
    if (GIT_WRITE.has(sub)) writes.push(...pathTokens);
    else if (GIT_READ.has(sub)) reads.push(...pathTokens);
    else reads.push(...pathTokens); // unknown git subcmd with paths → deny via read gate
    return { reads, writes };
  }

  if (READ_VERBS.has(verb)) {
    reads.push(...rest.filter(looksLikePath));
    return { reads, writes };
  }

  if (WRITE_VERBS.has(verb)) {
    writes.push(...rest.filter(looksLikePath));
    return { reads, writes };
  }

  // Unrecognized verb. If it carries no path-shaped argv, allow (CC's own
  // Bash gate decides). If it does carry paths, force the read gate to
  // evaluate them — conservative deny for unknown shapes that touch paths.
  const pathTokens = rest.filter(looksLikePath);
  if (pathTokens.length === 0) return { reads, writes };
  reads.push(...pathTokens);
  return { reads, writes };
}
