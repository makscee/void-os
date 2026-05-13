// Vault writer. Atomic ops + per-file mutex. Sole gateway for vault.* MCP tools.

export { createVaultWriter } from './writer';
export type { VaultWriter, WriteCtx, VaultWriterOpts } from './writer';
