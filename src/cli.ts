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
} else {
  console.error("usage: void-os <init|serve> [options]");
  process.exit(2);
}
