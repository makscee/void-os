import { describe, test, expect } from "bun:test";
import { urlsFromAttachment } from "../src/daemon-urls.ts";
import type { DaemonAttachment } from "../src/daemon-lifecycle.ts";

const ATT: DaemonAttachment = {
  port: 7777,
  vault_root: "/tmp/v",
  version: "0.0.0",
};

describe("urlsFromAttachment", () => {
  test("no daemonUrl → uses attachment.port", () => {
    const u = urlsFromAttachment(ATT);
    expect(u.http).toBe("http://127.0.0.1:7777");
    expect(u.ws).toBe("ws://127.0.0.1:7777/events");
  });

  test("empty daemonUrl → falls back to attachment.port", () => {
    const u = urlsFromAttachment(ATT, "");
    expect(u.http).toBe("http://127.0.0.1:7777");
    expect(u.ws).toBe("ws://127.0.0.1:7777/events");
  });

  test("daemonUrl override wins over attachment.port", () => {
    // Simulates smoke-harness data.json: plugin must target the per-ID
    // smoke daemon, not the attachment-probe value (which may resolve to
    // the operator's main daemon if HOME inheritance gets tripped up).
    const u = urlsFromAttachment(ATT, "http://127.0.0.1:7842");
    expect(u.http).toBe("http://127.0.0.1:7842");
    expect(u.ws).toBe("ws://127.0.0.1:7842/events");
  });

  test("https daemonUrl → wss ws origin", () => {
    const u = urlsFromAttachment(ATT, "https://example.test:9000");
    expect(u.http).toBe("https://example.test:9000");
    expect(u.ws).toBe("wss://example.test:9000/events");
  });

  test("malformed daemonUrl → silent fallback to attachment", () => {
    const u = urlsFromAttachment(ATT, "not a url");
    expect(u.http).toBe("http://127.0.0.1:7777");
    expect(u.ws).toBe("ws://127.0.0.1:7777/events");
  });

  test("daemonUrl with trailing slash is normalised", () => {
    const u = urlsFromAttachment(ATT, "http://127.0.0.1:7842/");
    expect(u.http).toBe("http://127.0.0.1:7842");
    expect(u.ws).toBe("ws://127.0.0.1:7842/events");
  });
});
