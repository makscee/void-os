import * as fs from 'node:fs';
import * as path from 'node:path';

export const ERR = {
  PATH_MUST_BE_RELATIVE: 'PATH_MUST_BE_RELATIVE',
  PATH_ESCAPES_VAULT_ROOT: 'PATH_ESCAPES_VAULT_ROOT',
} as const;

export function resolveVaultPath(rel: string, vaultRootReal: string): string {
  if (path.isAbsolute(rel)) throw new Error(ERR.PATH_MUST_BE_RELATIVE);
  const abs = path.resolve(vaultRootReal, rel);
  const segments: string[] = [];
  let cursor = abs;
  while (!fs.existsSync(cursor)) {
    segments.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(ERR.PATH_ESCAPES_VAULT_ROOT);
    cursor = parent;
  }
  const real = path.join(fs.realpathSync(cursor), ...segments);
  if (real !== vaultRootReal && !real.startsWith(vaultRootReal + path.sep)) {
    throw new Error(ERR.PATH_ESCAPES_VAULT_ROOT);
  }
  return real;
}
