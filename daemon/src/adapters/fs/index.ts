// Filesystem adapter. Vault reads + atomic writes (tmp + rename).

export interface FsAdapter {
  read(path: string): Promise<string>;
  writeAtomic(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export const createFsAdapter = (): FsAdapter => {
  throw new Error("not implemented");
};
