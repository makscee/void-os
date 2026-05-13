import { spawn } from "node:child_process"
import { join } from "node:path"

export default async function cli(args: string[], ctx: { prefix: string }) {
  const entry = join(ctx.prefix, "daemon/src/index.ts")
  const child = spawn("bun", ["run", entry, ...args], {
    stdio: "inherit",
    env: process.env,
  })
  child.on("exit", (code) => process.exit(code ?? 0))
  await new Promise(() => {}) // hang until child exits
}
