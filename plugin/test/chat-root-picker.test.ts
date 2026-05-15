// VOS-92 T4.1: ChatRoot's onNewChat opens the agent picker; createChat is
// called with the picked agent's name. Picker returns Promise<AgentListEntry | null>.

import { describe, expect, test } from "bun:test";
import { wireOnNewChat } from "../src/chat/ChatRoot";

describe("wireOnNewChat", () => {
  test("picker returns an agent → createChat called with its name", async () => {
    const createCalls: string[] = [];
    const mintedIds: string[] = [];
    let refreshes = 0;

    const onNewChat = wireOnNewChat({
      api: {
        createChat: async (agent?: string) => {
          createCalls.push(agent ?? "(none)");
          return { id: "c1", title: "t", created_at: 0 };
        },
      },
      openPicker: async () => ({ name: "journaler", description: "x" }),
      onChatIdMinted: async (id) => { mintedIds.push(id); },
      bumpRefresh: () => { refreshes++; },
      fallbackAgent: "maya",
    });

    await onNewChat();
    expect(createCalls).toEqual(["journaler"]);
    expect(mintedIds).toEqual(["c1"]);
    expect(refreshes).toBe(1);
  });

  test("picker returns null (dismiss) → no chat created, no refresh", async () => {
    const createCalls: string[] = [];
    let refreshes = 0;

    const onNewChat = wireOnNewChat({
      api: {
        createChat: async (agent?: string) => {
          createCalls.push(agent ?? "(none)");
          return { id: "c1", title: "t", created_at: 0 };
        },
      },
      openPicker: async () => null,
      onChatIdMinted: async () => {},
      bumpRefresh: () => { refreshes++; },
      fallbackAgent: "maya",
    });

    await onNewChat();
    expect(createCalls).toEqual([]);
    expect(refreshes).toBe(0);
  });
});
