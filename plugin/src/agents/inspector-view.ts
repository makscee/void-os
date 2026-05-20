// VOS-160: InspectorView — Obsidian ItemView host for the in-flight
// agent inspector. Mirrors the ChatView pattern (plugin/src/view.ts):
// a thin ItemView shell that mounts a React root in onOpen and unmounts
// it in onClose.

import { ItemView, type WorkspaceLeaf } from "obsidian";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { InspectorRoot, type InspectorRootProps } from "./InspectorRoot";

export const INSPECTOR_VIEW_TYPE = "void-os-inspector";

/** Late-bound deps so the view always reads the latest plugin state
 *  (e.g. the InflightApi rebuilt after a daemon restart). */
export type InspectorViewDeps = () => InspectorRootProps;

export class InspectorView extends ItemView {
  private root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, private deps: InspectorViewDeps | null = null) {
    super(leaf);
  }

  getViewType() { return INSPECTOR_VIEW_TYPE; }
  getDisplayText() { return "void-os inspector"; }
  getIcon() { return "activity"; }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.style.padding = "0";
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.minHeight = "0";
    const mount = container.createDiv({ cls: "void-os-inspector-root" });
    mount.style.flex = "1";
    mount.style.minHeight = "0";
    mount.style.display = "flex";
    this.root = createRoot(mount);
    if (this.deps) {
      this.root.render(React.createElement(InspectorRoot, this.deps()));
    } else {
      // Fallback for the smoke path: empty placeholder so onOpen doesn't
      // throw when no deps are wired.
      this.root.render(React.createElement("div", null));
    }
  }

  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}
