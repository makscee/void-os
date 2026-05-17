import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingsStore } from "./chat/settings.ts";
import type { DaemonStatus } from "./main";

/**
 * Minimum shape the settings tab needs from VoidOsPlugin. Kept as a structural
 * interface (rather than importing the concrete class) so we can construct the
 * tab from `onload` without a value-import cycle: main.ts already imports this
 * file, and importing the class back into here would form one.
 */
export interface SettingsTabHost {
  settings: SettingsStore;
  daemonStatus: DaemonStatus;
  restartDaemon(): Promise<void>;
}

export class VoidOsSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: SettingsTabHost) {
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

    containerEl.createEl("h3", { text: "Daemon" });
    this.renderDaemonSection(containerEl);
  }

  private renderDaemonSection(containerEl: HTMLElement): void {
    const s = this.plugin.daemonStatus;
    const cur = this.plugin.settings.get();

    new Setting(containerEl)
      .setName("Daemon status")
      .setDesc(this.describeStatus(s))
      .addExtraButton((btn) => {
        btn.setIcon("refresh").setTooltip("Refresh").onClick(() => this.display());
      });

    if (s.state === "running") {
      new Setting(containerEl).setName("Vault root").setDesc(s.vault);
      new Setting(containerEl).setName("Version").setDesc(s.version);
    }

    new Setting(containerEl)
      .setName("Resolved binary path")
      .setDesc(cur.resolvedBinaryPath ?? "(not resolved)");

    new Setting(containerEl)
      .setName("Binary path override")
      .setDesc("Absolute path to the void-os binary. Leave empty to auto-detect.")
      .addText((t) => {
        t.setValue(cur.voidOsBinaryPath ?? "").onChange(async (v) => {
          await this.plugin.settings.setVoidOsBinaryPath(v.trim() || undefined);
        });
      });

    // Restart is only meaningful when the previous spawn produced a terminal
    // failure state — running/vault-mismatch don't have anything to restart.
    const canRestart = s.state === "daemon-died" || s.state === "spawn-failed";
    if (canRestart) {
      new Setting(containerEl)
        .setName("Restart daemon")
        .addButton((b) => {
          b.setButtonText("Restart").setCta().onClick(async () => {
            await this.plugin.restartDaemon();
            this.display();
          });
        });
    } else if (s.state === "vault-mismatch") {
      new Setting(containerEl)
        .setName("Close other vault first")
        .setDesc(
          `Daemon is serving ${s.activeVault}. Quit that Obsidian window, then refresh.`,
        );
    }
  }

  private describeStatus(s: DaemonStatus): string {
    switch (s.state) {
      case "running":
        return `running on port ${s.port}`;
      case "binary-missing":
        return "void-os binary not found";
      case "vault-mismatch":
        return `serving different vault: ${s.activeVault}`;
      case "spawn-failed":
        return `failed to start: ${s.error}`;
      case "daemon-died":
        return "daemon process is dead";
    }
  }
}
