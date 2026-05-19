import type { DaemonStatus } from "./daemon-status";

export function iconFor(s: DaemonStatus): "circle-dot" | "circle-alert" {
  return s.state === "running" ? "circle-dot" : "circle-alert";
}

export function tooltipFor(s: DaemonStatus): string {
  switch (s.state) {
    case "running":         return "void-os chat";
    case "binary-missing":  return "void-os degraded — binary not found";
    case "vault-mismatch":  return "void-os degraded — another vault is active";
    case "spawn-failed":    return "void-os degraded — daemon failed to start";
    case "daemon-died":     return "void-os degraded — daemon died";
  }
}

export function statusBarTextFor(s: DaemonStatus): string {
  if (s.state === "running") return "void-os: connected";
  return `void-os: ${s.state}`;
}

export function degradedHeadlineFor(s: DaemonStatus): string {
  switch (s.state) {
    case "running":         return ""; // not used in degraded modal
    case "binary-missing":  return "Daemon binary not found";
    case "vault-mismatch":  return "Another vault is active";
    case "spawn-failed":    return "Daemon failed to start";
    case "daemon-died":     return "Daemon died";
  }
}

export function degradedBodyFor(s: DaemonStatus): string {
  switch (s.state) {
    case "running":
      return "";
    case "binary-missing":
      return "void-os couldn't find the daemon binary on PATH. Set the binary path in plugin settings, then click Retry daemon.";
    case "vault-mismatch":
      return `A void-os daemon is already running for a different vault (${s.activeVault}). Close that vault first, then click Retry daemon.`;
    case "spawn-failed":
      return `void-os tried to start the daemon but it exited immediately. Error: ${s.error}`;
    case "daemon-died":
      return "The void-os daemon was running but its process exited. Click Retry daemon to spawn a fresh one.";
  }
}
