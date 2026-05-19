import type { ConnectionState } from "./state";

const LABELS: Record<ConnectionState, string> = {
  connected:    "void-os: connected",
  reconnecting: "void-os: reconnecting",
  offline:      "void-os: offline",
};

export type StatusBarMode = "fsm" | "degraded";

export class StatusBar {
  private mode: StatusBarMode = "fsm";

  constructor(private el: { setText(s: string): void }) { this.update("offline"); }

  update(s: ConnectionState) {
    if (this.mode === "degraded") return;
    this.el.setText(LABELS[s]);
  }

  setMode(mode: StatusBarMode) { this.mode = mode; }

  setStateText(text: string) { this.el.setText(text); }
}
