import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function ensureToken(): string {
  const home = process.env.HOME ?? os.homedir();
  const dir = path.join(home, ".void-os");
  const file = path.join(dir, "token");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tok = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, tok + "\n", { mode: 0o600 });
    return tok;
  }
  return fs.readFileSync(file, "utf8").trim();
}
