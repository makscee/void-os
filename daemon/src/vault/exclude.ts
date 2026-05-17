// Returns true if any path segment starts with "." — covers .obsidian, .git,
// .env, .DS_Store, and arbitrarily nested hidden dirs/files.
export function isExcluded(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  for (const seg of norm.split("/")) {
    if (seg.startsWith(".") && seg !== "" && seg !== "." && seg !== "..") {
      return true;
    }
  }
  return false;
}
