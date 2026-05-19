/**
 * vault.load_template MCP tool (VOS-131).
 *
 * Input:  { name: string, context?: Record<string,string>, allow_missing?: boolean }
 * Output: { content: [{type:'text', text}], structuredContent: { name, path, slots, rendered? } }
 *         or { isError: true, content: [{type:'text', text: '<CODE>: <message>'}] }
 *
 * Behavior:
 * - When `context` is omitted, the tool returns the template's raw contents +
 *   slot inventory without rendering. Agents call this shape to inspect what
 *   slots exist before binding context.
 * - When `context` is provided, the tool renders and returns the substituted
 *   text. Missing slots fail-closed with `MISSING_SLOT` unless
 *   `allow_missing: true` is passed.
 *
 * Error codes: TEMPLATE_NOT_FOUND, MALFORMED_TEMPLATE, MISSING_SLOT, IO_ERROR.
 */
import { z } from "zod/v3";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  loadTemplate,
  renderTemplate,
  TemplateError,
  ERR as TPL_ERR,
} from "../../../lib/load-template.ts";

export const vaultLoadTemplateInput = {
  name: z.string().min(1),
  context: z.record(z.string()).optional(),
  allow_missing: z.boolean().optional(),
} satisfies z.ZodRawShape;

export const vaultLoadTemplateDef = {
  description:
    "Load a template from _templates/<name>.md. With context, returns the rendered text; without, returns the raw template + slot inventory.",
  inputSchema: vaultLoadTemplateInput,
};

export interface VaultLoadTemplateDeps {
  vaultRoot: string;
}

function errResult(code: string, msg: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `${code}: ${msg}` }] };
}

export function makeVaultLoadTemplate(deps: VaultLoadTemplateDeps) {
  const { vaultRoot } = deps;
  return async (
    args: z.objectOutputType<typeof vaultLoadTemplateInput, z.ZodTypeAny>,
  ): Promise<CallToolResult> => {
    let loaded;
    try {
      loaded = loadTemplate(args.name, vaultRoot);
    } catch (e) {
      if (e instanceof TemplateError) return errResult(e.code, e.detail);
      return errResult("IO_ERROR", (e as Error).message);
    }

    // Inspect mode: no context → return raw + slot inventory.
    if (args.context === undefined) {
      const relPath = `_templates/${loaded.name}.md`;
      return {
        content: [{ type: "text", text: loaded.raw }],
        structuredContent: {
          name: loaded.name,
          path: relPath,
          slots: loaded.slots,
        },
      };
    }

    // Render mode: substitute context.
    let rendered: string;
    try {
      rendered = renderTemplate(loaded.raw, args.context, {
        allowMissing: args.allow_missing,
      });
    } catch (e) {
      if (e instanceof TemplateError) return errResult(e.code, e.detail);
      return errResult("IO_ERROR", (e as Error).message);
    }

    const relPath = `_templates/${loaded.name}.md`;
    return {
      content: [{ type: "text", text: rendered }],
      structuredContent: {
        name: loaded.name,
        path: relPath,
        slots: loaded.slots,
        rendered,
      },
    };
  };
}

// Re-export the error code set so tests can assert against it without
// importing the lib module directly.
export const ERR = TPL_ERR;
