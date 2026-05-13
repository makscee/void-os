import type { ConnectionState } from "./state";

const LABELS: Record<ConnectionState, string> = {
  connected:    "void-os: connected",
  reconnecting: "void-os: reconnecting",
  offline:      "void-os: offline",
};

export class StatusBar {
  constructor(private el: HTMLElement) { this.update("offline"); }
  update(s: ConnectionState) { this.el.setText(LABELS[s]); }
}
