// VOS-109: renderer for the synthesised denial DataMessagePart.
//
// The reducer's DenialPart (kind:"denial") is translated by
// runtime.ts::toThreadMessage into an assistant-ui DataMessagePart of the
// form `{type:"data", name:"denial", data:{toolCallId, reason, attemptedPath,
// agent, message}}`. ChatRoot wires this component into
// MessagePrimitive.Parts via `components.data.by_name.denial`.
//
// Visual: red-tinted border + background_modifier_error tinted fill
// + leading ⛔ glyph. Mirrors GenericTool's Obsidian-token vocabulary so the
// row sits visually adjacent to (and harmonises with) the offending tool
// row above it.

import * as React from "react";
import type { DataMessagePartComponent } from "@assistant-ui/react";

export type DenialData = {
  toolCallId: string;
  reason: "scope_violation";
  attemptedPath: string;
  agent: string;
  message: string;
};

export const DenialPart: DataMessagePartComponent<DenialData> = (props) => {
  const data = props.data;
  return (
    <div
      data-testid="turn-denial"
      data-denial-reason={data.reason}
      data-tool-call-id={data.toolCallId}
      className={
        "vos:my-[var(--size-4-2)] vos:px-[var(--size-4-3)] vos:py-[var(--size-4-2)] " +
        "vos:rounded-[var(--radius-s)] vos:border " +
        "vos:border-[var(--text-error,#e35a5a)] " +
        "vos:bg-[var(--background-modifier-error,#a0303d)] " +
        "vos:text-[var(--text-on-accent)] " +
        "vos:flex vos:items-start vos:gap-[var(--size-4-2)] " +
        "vos:text-sm vos:leading-relaxed"
      }
    >
      <span
        aria-hidden="true"
        className="vos:select-none vos:text-base vos:leading-none vos:mt-[2px]"
      >
        ⛔
      </span>
      <span className="vos:whitespace-pre-wrap vos:break-words vos:flex-1">
        {data.message}
      </span>
    </div>
  );
};
