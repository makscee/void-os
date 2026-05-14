// Minimal plugin settings — just the pinned chatId for S2.
// S3 will add a real settings tab + chat list; for now we live on a single
// hard-pinned chat persisted via Obsidian Plugin.loadData/saveData.

export interface VoidOsSettings {
  chatId: string | null;
}

export const DEFAULT_SETTINGS: VoidOsSettings = {
  chatId: null,
};

export interface SettingsStore {
  get(): VoidOsSettings;
  setChatId(id: string): Promise<void>;
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
  };
}
