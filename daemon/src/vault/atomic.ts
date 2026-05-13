import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export async function atomicWrite(
  absPath: string,
  content: string,
  tmpDir: string,
  opts: { crashAfterTmpWrite?: boolean } = {}
): Promise<void> {
  // tmpDir must be on the same filesystem as absPath so rename is atomic.
  // Callers (createVaultWriter) ensure tmpDir = <vaultRoot>/.void/tmp/.
  const tmp = path.join(tmpDir, `${path.basename(absPath)}.${randomBytes(6).toString('hex')}`);
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(content);
    await fh.sync();
  } finally {
    await fh.close();
  }
  if (opts.crashAfterTmpWrite) throw new Error('SIMULATED_CRASH');
  await fs.rename(tmp, absPath);
}
