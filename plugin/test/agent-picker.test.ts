// VOS-92 T3.4: openAgentPicker — fetches agents, hands them to a modal
// factory, returns the picked AgentListEntry (or null on dismiss / error).
// The factory owns modal lifecycle and returns a promise that resolves
// with the user's choice. Single contract — no separate onChoose callback.

import { describe, expect, test } from "bun:test";
import {
  openAgentPicker,
  type AgentPickerDeps,
  type AgentPickerFactory,
} from "../src/agents/picker";
import type { AgentListEntry } from "../src/agents/types";

function makeDeps(overrides: Partial<AgentPickerDeps> = {}): AgentPickerDeps & {
  modalFactoryCalls: Array<{ items: AgentListEntry[] }>;
  noticeCalls: string[];
} {
  const modalFactoryCalls: Array<{ items: AgentListEntry[] }> = [];
  const noticeCalls: string[] = [];

  const modalFactory: AgentPickerFactory = (items) => {
    modalFactoryCalls.push({ items });
    // Default fake: resolve with the first item (or null if empty).
    return Promise.resolve(items[0] ?? null);
  };

  return {
    agentsApi: {
      listAgents: async () => [
        { name: "maya", description: "front desk" },
        { name: "journaler", description: "writes" },
      ],
    },
    onError: (msg: string) => { noticeCalls.push(msg); },
    modalFactory,
    ...overrides,
    modalFactoryCalls,
    noticeCalls,
  };
}

describe("openAgentPicker", () => {
  test("fetches agents, passes them to modal factory, returns first pick", async () => {
    const deps = makeDeps();
    const picked = await openAgentPicker(deps);
    expect(deps.modalFactoryCalls.length).toBe(1);
    expect(deps.modalFactoryCalls[0].items.map((a) => a.name)).toEqual(["maya", "journaler"]);
    expect(picked).toEqual({ name: "maya", description: "front desk" });
  });

  test("empty agent list still opens modal, returns null", async () => {
    const deps = makeDeps({
      agentsApi: { listAgents: async () => [] },
    });
    const picked = await openAgentPicker(deps);
    expect(deps.modalFactoryCalls.length).toBe(1);
    expect(deps.modalFactoryCalls[0].items).toEqual([]);
    expect(picked).toBeNull();
  });

  test("listAgents throws → onError called, no modal opened, returns null", async () => {
    const deps = makeDeps({
      agentsApi: { listAgents: async () => { throw new Error("daemon down"); } },
    });
    const picked = await openAgentPicker(deps);
    expect(deps.modalFactoryCalls.length).toBe(0);
    expect(deps.noticeCalls.length).toBe(1);
    expect(deps.noticeCalls[0]).toMatch(/could not load agents/i);
    expect(picked).toBeNull();
  });

  test("user dismisses modal → factory resolves null → openAgentPicker returns null", async () => {
    const deps = makeDeps({
      modalFactory: (items) => {
        return Promise.resolve(null);
      },
    });
    const picked = await openAgentPicker(deps);
    expect(picked).toBeNull();
  });
});
