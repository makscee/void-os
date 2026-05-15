import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingsStore } from "./chat/settings.ts";

export class VoidOsSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: { settings: SettingsStore }) {
    super(app, plugin as any);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "void-os" });

    new Setting(containerEl)
      .setName("Daemon URL")
      .setDesc("HTTP origin of the void-os daemon. Leave blank for http://127.0.0.1:7777.")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:7777")
          .setValue(this.plugin.settings.get().daemonUrl ?? "")
          .onChange(async (value) => {
            await this.plugin.settings.setDaemonUrl(value.trim() || undefined);
          }),
      );
  }
}
