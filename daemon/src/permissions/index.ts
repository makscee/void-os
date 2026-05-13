// Folder permissions. Computes per-spawn CC settings (allowed tools, paths).

export interface FolderPermission {
  path: string;
  label: string;
  access: "read" | "write" | "none";
  agents: string[];
}

export interface CcSpawnSettings {
  allowedTools: string[];
  disallowedPaths: string[];
  permissionPromptTool?: string;
}

export interface PermissionResolver {
  listFolders(): Promise<FolderPermission[]>;
  setFolders(folders: FolderPermission[]): Promise<void>;
  computeCcSettings(agent: string): Promise<CcSpawnSettings>;
}

export const createPermissionResolver = (): PermissionResolver => {
  throw new Error("not implemented");
};
