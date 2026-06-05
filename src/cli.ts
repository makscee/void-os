export {};
const cmd = process.argv[2];

if (cmd === "init") {
  // argv[3] is the optional vault dir (non-interactive path)
  const vaultArg = process.argv[3];
  const { runInit } = await import("./init.ts");
  await runInit(vaultArg);
} else if (cmd === "serve") {
  const { runServe } = await import("./serve.ts");
  await runServe();
} else if (cmd === "list-sessions") {
  const { listSessions } = await import("./sessions.ts");
  const { resolveVault } = await import("./serve.ts");
  const vault = resolveVault(process.env as Record<string, string | undefined>, process.cwd());
  const sessions = listSessions(vault);
  if (sessions.length === 0) {
    console.log("no sessions found in", vault);
  } else {
    for (const s of sessions) {
      const flag = s.error ? " [error]" : "";
      console.log(`  ${s.uuid}  ${s.title || "(untitled)"}${flag}`);
    }
  }
} else if (!cmd) {
  // No subcommand — open the interactive arrow-key TUI menu (TTY) or print help (non-TTY)
  const { runMenu, actionToArgv, isTty } = await import("./tui.ts");

  if (!isTty()) {
    console.error("usage: void-os <init|serve|list-sessions|doctor> [options]");
    process.exit(2);
  }

  const action = await runMenu();

  if (!action || action === "quit") {
    process.exit(0);
  }

  // Re-dispatch by mutating argv and re-entering the command branches
  const argv = actionToArgv(action);
  process.argv[2] = argv[0];
  if (argv[1]) process.argv[3] = argv[1];

  // Execute the selected action
  if (action === "init") {
    const { runInit } = await import("./init.ts");
    await runInit(process.argv[3]);
  } else if (action === "serve") {
    const { runServe } = await import("./serve.ts");
    await runServe();
  } else if (action === "list-sessions") {
    const { listSessions } = await import("./sessions.ts");
    const { resolveVault } = await import("./serve.ts");
    const vault = resolveVault(process.env as Record<string, string | undefined>, process.cwd());
    const sessions = listSessions(vault);
    if (sessions.length === 0) {
      console.log("no sessions found in", vault);
    } else {
      for (const s of sessions) {
        const flag = s.error ? " [error]" : "";
        console.log(`  ${s.uuid}  ${s.title || "(untitled)"}${flag}`);
      }
    }
  }
} else if (cmd === "trigger-fire") {
  const name = process.argv[3];
  if (!name) { console.error("usage: void-os trigger-fire <name>"); process.exit(1); }
  const { resolveVault } = await import("./serve.ts");
  const { readConfig } = await import("./paths.ts");
  const vault = resolveVault(process.env as Record<string, string | undefined>, process.cwd());
  const port = readConfig(vault).port;
  const res = await fetch(`http://127.0.0.1:${port}/triggers/${name}/fire`, { method: "POST" });
  console.log(await res.text());
} else if (cmd === "attach") {
  // VOS-205: park the operator's terminal as a daemon-driven tmux client on the -L vos socket.
  // The daemon retargets which session is viewed via POST /s/:uuid/attach-here (switch-client).
  const { runAttach } = await import("./attach.ts");
  runAttach();
} else if (cmd === "doctor") {
  // VOS-232: list all running void-os daemons (pid·port·vault·stale?); --kill-stale cleans up.
  const { runDoctor } = await import("./doctor.ts");
  await runDoctor(process.argv.slice(3));
} else if (cmd === "install-skill") {
  // VOS-235: safe deterministic catalog skill installer — no shell rm of variable paths.
  // Usage: void-os install-skill <name> [--vault <path>] [--catalog <path>]
  // Env fallbacks: VOID_OS_VAULT, VOID_OS_CATALOG_ROOT.
  const name = process.argv[3];
  if (!name) {
    console.error("usage: void-os install-skill <name>");
    process.exit(1);
  }
  const { resolveVault } = await import("./serve.ts");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { installCatalogSkill } = await import("./install-skill.ts");
  const vault = resolveVault(process.env as Record<string, string | undefined>, process.cwd());
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const catalogRoot = (process.env as Record<string, string | undefined>).VOID_OS_CATALOG_ROOT ?? join(repoRoot, "catalog");
  const result = installCatalogSkill({ vault, catalogRoot, name });
  if (result.ok) {
    console.log(`installed ${name} → ${result.destDir}`);
  } else {
    console.error(`install-skill failed: ${result.error}`);
    process.exit(1);
  }
} else {
  console.error(`unknown command: ${cmd}`);
  console.error("usage: void-os <init|serve|list-sessions|trigger-fire|attach|doctor|install-skill> [options]");
  process.exit(2);
}
