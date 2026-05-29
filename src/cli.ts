export {};
const cmd = process.argv[2];
if (cmd === "init") {
  const { runInit } = await import("./init.ts");
  await runInit();
} else if (cmd === "serve") {
  const { runServe } = await import("./serve.ts");
  await runServe();
} else {
  console.error("usage: void-os <init|serve>");
  process.exit(2);
}
