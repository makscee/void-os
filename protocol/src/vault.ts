import { z } from "zod";

export const VAULT_ERR = z.enum([
  "E_NOT_FOUND",
  "E_OUT_OF_SCOPE",
  "E_TRAVERSAL",
  "E_BINARY",
  "E_EXCLUDED",
  "E_SYMLINK_ESCAPE",
  "E_TOO_LARGE",
  "E_INVALID_BODY",
]);
export type VaultErr = z.infer<typeof VAULT_ERR>;

export const VaultReadResp = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.number().int().nonnegative(),
});
export type VaultReadResp = z.infer<typeof VaultReadResp>;

export const VaultWriteReq = z.object({
  path: z.string().min(1),
  content: z.string().max(10 * 1024 * 1024),
});
export type VaultWriteReq = z.infer<typeof VaultWriteReq>;

export const VaultWriteResp = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.number().int().nonnegative(),
});
export type VaultWriteResp = z.infer<typeof VaultWriteResp>;

export const VaultListEntry = z.object({
  name: z.string(),
  type: z.enum(["file", "dir"]),
  size: z.number().int().nonnegative(),
  mtime: z.number().int().nonnegative(),
});
export type VaultListEntry = z.infer<typeof VaultListEntry>;

export const VaultListResp = z.object({
  path: z.string(),
  entries: z.array(VaultListEntry),
});
export type VaultListResp = z.infer<typeof VaultListResp>;
