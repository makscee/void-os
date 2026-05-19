import { App, Modal, Notice, Setting } from "obsidian";
import type VoidOsPlugin from "./main";
import { degradedHeadlineFor, degradedBodyFor } from "./ribbon-state";

export class DegradedHelpModal extends Modal {
  private retryInFlight = false;

  constructor(app: App, private plugin: VoidOsPlugin) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.setAttribute("data-testid", "vos-degraded-modal");
    this.renderBody();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** Empty + rebuild contentEl from current daemonStatus. Safe to call
   *  re-entrantly from button handlers — does NOT re-invoke onOpen, which
   *  would detach the still-on-stack button reference and leave the `finally`
   *  block mutating a stale node. */
  private renderBody(): void {
    const { contentEl } = this;
    contentEl.empty();

    const status = this.plugin.daemonStatus;
    contentEl.createEl("h2", { text: degradedHeadlineFor(status) });
    contentEl.createEl("p", { text: degradedBodyFor(status) });

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Open settings")
         .setCta()
         .onClick(() => {
           this.close();
           this.openSettings();
         })
      )
      .addButton((b) => {
        b.setButtonText("Retry daemon").onClick(() => void this.onRetry(b));
        if (this.plugin.daemonStatus.state === "running") b.setDisabled(true);
        return b;
      });
  }

  private openSettings(): void {
    const setting = (this.app as unknown as {
      setting?: {
        open(): void;
        openTabById(id: string): void;
      };
    }).setting;
    if (setting) {
      setting.open();
      setting.openTabById(this.plugin.manifest.id);
    } else {
      new Notice("Open Settings → Community plugins → void-os manually");
    }
  }

  private async onRetry(button: { setButtonText(s: string): unknown; setDisabled(d: boolean): unknown }): Promise<void> {
    if (this.retryInFlight) return;
    if (this.plugin.daemonStatus.state === "running") {
      new Notice("daemon already attached");
      this.close();
      return;
    }
    this.retryInFlight = true;
    button.setButtonText("Retrying…");
    button.setDisabled(true);
    try {
      await this.plugin.attemptDaemon();
    } finally {
      this.retryInFlight = false;
      if (this.plugin.daemonStatus.state === "running") {
        new Notice("daemon attached");
        this.close();
      } else {
        // Rebuild body with new state so headline + body reflect the latest
        // error. Use renderBody (NOT onOpen) — the button whose onClick we're
        // inside is about to be detached by contentEl.empty(); going through
        // onOpen would re-add the modal-level data-testid attribute we don't
        // need to touch again and obscures the intent.
        this.renderBody();
      }
    }
  }
}
