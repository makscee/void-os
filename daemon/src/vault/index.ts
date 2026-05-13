// Vault writer. Atomic ops + per-file mutex. Sole gateway for vault.* MCP tools.

export interface VaultWriter {
  read(path: string): Promise<string>;
  append(path: string, content: string, section?: string): Promise<void>;
  replaceSection(path: string, section: string, content: string): Promise<void>;
  setProperty(path: string, key: string, value: unknown): Promise<void>;
  patch(path: string, oldString: string, newString: string): Promise<void>;
  create(path: string, content: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export const createVaultWriter = (): VaultWriter => {
  throw new Error("not implemented");
};
