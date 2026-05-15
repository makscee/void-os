// Minimal plugin settings — just the pinned chatId for S2.
// S3 will add a real settings tab + chat list; for now we live on a single
// hard-pinned chat persisted via Obsidian Plugin.loadData/saveData.

export interface VoidOsSettings {
  chatId: string | null;
  daemonUrl?: string;
}

export const DEFAULT_SETTINGS: VoidOsSettings = {
  chatId: null,
  // daemonUrl omitted on purpose: undefined ⇒ caller uses built-in default
};

export interface SettingsStore {
  get(): VoidOsSettings;
  setChatId(id: string): Promise<void>;
  setDaemonUrl(url: string | undefined): Promise<void>;
}

export interface SettingsIO {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export async function makeSettingsStore(io: SettingsIO): Promise<SettingsStore> {
  const raw = (await io.loadData().catch(() => null)) as Partial<VoidOsSettings> | null;
  let current: VoidOsSettings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  return {
    get: () => current,
    async setChatId(id: string) {
      current = { ...current, chatId: id };
      await io.saveData(current);
    },
    async setDaemonUrl(url: string | undefined) {
      current = { ...current, daemonUrl: url };
      await io.saveData(current);
    },
  };
}
