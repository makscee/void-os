import matter from 'gray-matter';

export function parseFm(content: string): { data: Record<string, unknown>; body: string } {
  const r = matter(content);
  return { data: { ...r.data }, body: r.content };
}

export function stringifyFm(data: Record<string, unknown>, body: string): string {
  // matter.stringify emits `---\n<yaml>---\n<body>`; it handles missing-fm case by
  // always emitting the delimiter block when `data` has keys, and emitting only `body`
  // when `data` is empty.
  if (Object.keys(data).length === 0) return body;
  return matter.stringify(body, data);
}
