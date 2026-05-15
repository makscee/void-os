// VOS-92 T3.5: openAgentPicker — fetches agents, hands them to a modal
// factory that owns lifecycle, returns the pick (or null on dismiss/error).
//
// Contract: AgentPickerFactory returns Promise<AgentListEntry | null>.
// - Resolves with the picked entry when user selects one.
// - Resolves with null when user dismisses without picking.
// Single source of truth — no separate onChoose callback or onClose hook.

import type { App, SuggestModal as SuggestModalT } from "obsidian";
import type { AgentsApi } from "./api";
import type { AgentListEntry } from "./types";

export type AgentPickerFactory = (
  items: AgentListEntry[],
) => Promise<AgentListEntry | null>;

export interface AgentPickerDeps {
  agentsApi: Pick<AgentsApi, "listAgents">;
  onError: (message: string) => void;
  modalFactory: AgentPickerFactory;
}

const EMPTY_NOTICE = "No agents in vault/agents/. Add an agent.md to get started.";

export async function openAgentPicker(
  deps: AgentPickerDeps,
): Promise<AgentListEntry | null> {
  let items: AgentListEntry[];
  try {
    items = await deps.agentsApi.listAgents();
  } catch {
    deps.onError("Void: could not load agents — is the daemon running?");
    return null;
  }
  return deps.modalFactory(items);
}

/**
 * Real-Obsidian factory. Returns a promise that resolves on
 * onChooseSuggestion (with the entry) or onClose (with null if no choice).
 * Not exercised in bun:test because instantiating SuggestModal requires
 * a live Obsidian App.
 */
export function makeRealAgentPickerFactory(app: App): AgentPickerFactory {
  // Lazy require: obsidian ships .d.ts only — importing values at module load
  // breaks bun:test. The real factory is never called from tests.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SuggestModal } = require("obsidian") as { SuggestModal: typeof SuggestModalT };
  return (items) => {
    return new Promise<AgentListEntry | null>((resolve) => {
      let settled = false;
      const settle = (v: AgentListEntry | null) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };

      class Picker extends (SuggestModal as any)<AgentListEntry> {
        getSuggestions(query: string) {
          const q = query.toLowerCase();
          return items.filter(
            (i) =>
              i.name.toLowerCase().includes(q) ||
              i.description.toLowerCase().includes(q),
          );
        }
        renderSuggestion(item: AgentListEntry, el: HTMLElement) {
          el.createDiv({ text: item.name, cls: "void-agent-picker-name" });
          el.createDiv({ text: item.description, cls: "void-agent-picker-desc" });
        }
        onChooseSuggestion(item: AgentListEntry) {
          settle(item);
        }
        onClose() {
          super.onClose?.();
          // Fires after onChooseSuggestion on selection, and on bare dismiss.
          // `settle` is idempotent, so a prior selection wins.
          settle(null);
        }
      }
      const m = new (Picker as any)(app);
      m.setPlaceholder("Pick an agent…");
      // Native Obsidian guidance for the empty / no-match state — rendered
      // by SuggestModal as a non-selectable placeholder, so pressing Enter
      // does NOT close the modal with a null pick. Replaces the prior
      // {__empty:true} sentinel which rendered as a real (selectable) row.
      m.emptyStateText = EMPTY_NOTICE;
      m.open();
    });
  };
}

/** Surface for main.ts to wire a Notice when listAgents fails. */
export function defaultOnError(message: string) {
  // Lazy require — see makeRealAgentPickerFactory for rationale.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Notice } = require("obsidian") as { Notice: new (msg: string) => unknown };
  new Notice(message);
}
