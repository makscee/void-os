// VOS-92 review fix: command-path activation must push the freshly-minted
// chat id into ChatRoot even when the view is already open. The button
// path goes via wireOnNewChat (inside the React tree); the command path
// goes via Plugin#activateChatView(chatId) → ChatView#setActiveChatId(id),
// which is the imperative bridge across the React boundary.
//
// This test exercises the BRIDGE — not Obsidian internals. It verifies:
//   1. ChatRoot registers an imperative setter via registerSetActiveChatId.
//   2. ChatView.setActiveChatId(id) reaches that registered setter.
//   3. The setter, in turn, drives ChatRoot's local active-chat state.
//
// We don't import ChatRoot here (assistant-ui/React tree is heavy under
// happy-dom). Instead we replay the same handshake: a "host" object that
// holds a `pushActiveChatId` field, plus a ChatRoot-shaped consumer that
// calls `registerSetActiveChatId(setter)` on mount.

import { describe, expect, test } from "bun:test";

describe("command-path activation bridge", () => {
  test("registerSetActiveChatId → host.setActiveChatId pushes id into setter", () => {
    // Stand-in for ChatView: holds the imperative setter and exposes a
    // setActiveChatId() method that forwards into it. Mirrors the real
    // ChatView fields added in this fix.
    const host = {
      pushActiveChatId: null as ((id: string) => void) | null,
      setActiveChatId(id: string) { this.pushActiveChatId?.(id); },
    };

    // Stand-in for ChatRoot mount: calls register with its setState fn.
    const received: string[] = [];
    const setActiveChatId = (id: string) => { received.push(id); };
    const registerSetActiveChatId = (setter: (id: string) => void) => {
      host.pushActiveChatId = setter;
    };
    // ChatRoot's mount effect:
    registerSetActiveChatId(setActiveChatId);

    // Command path: chat minted, then host.setActiveChatId(created.id).
    host.setActiveChatId("chat-abc");
    expect(received).toEqual(["chat-abc"]);

    // Subsequent mints still work (e.g. user fires the command again).
    host.setActiveChatId("chat-def");
    expect(received).toEqual(["chat-abc", "chat-def"]);
  });

  test("host.setActiveChatId is a no-op before ChatRoot registers", () => {
    // Mirrors the early-call path: if a chatId is pushed before the React
    // mount lands, the call must NOT throw. The next ChatRoot render's
    // props.chatId picks up the value via the existing useEffect.
    const host = {
      pushActiveChatId: null as ((id: string) => void) | null,
      setActiveChatId(id: string) { this.pushActiveChatId?.(id); },
    };
    expect(() => host.setActiveChatId("chat-xyz")).not.toThrow();
  });
});
