// CAVEAT: fenced-block parsing is out of scope for v1. A `## ` at column 0
// inside a ``` ``` fenced code block will terminate the section. Add fence-aware
// logic before relying on this for files that embed markdown samples.

export interface SectionRange {
  headingLineStart: number;  // byte index of `## ` line start
  bodyStart: number;         // byte index right after heading's trailing \n
  bodyEnd: number;           // byte index at start of next `## ` line, or content.length
}

// Strip frontmatter for scanning so `##` in YAML is ignored.
// We scan the post-frontmatter region but return byte indices relative to the original string.
function frontmatterEnd(content: string): number {
  if (!content.startsWith('---\n')) return 0;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return 0;
  return end + 5; // past the closing `---\n`
}

export function findSection(content: string, heading: string): SectionRange | null {
  const scanFrom = frontmatterEnd(content);
  const needle = `## ${heading}`;
  // Match needle at start of line.
  let pos = scanFrom;
  while (pos < content.length) {
    const lineEnd = content.indexOf('\n', pos);
    const line = content.slice(pos, lineEnd === -1 ? content.length : lineEnd);
    if (line === needle || line.startsWith(needle + ' ')) {
      const headingLineStart = pos;
      const bodyStart = lineEnd === -1 ? content.length : lineEnd + 1;
      // find next `## ` at start of line
      let bodyEnd = content.length;
      let q = bodyStart;
      while (q < content.length) {
        const qEnd = content.indexOf('\n', q);
        const qLine = content.slice(q, qEnd === -1 ? content.length : qEnd);
        if (qLine.startsWith('## ')) { bodyEnd = q; break; }
        if (qEnd === -1) break;
        q = qEnd + 1;
      }
      return { headingLineStart, bodyStart, bodyEnd };
    }
    if (lineEnd === -1) break;
    pos = lineEnd + 1;
  }
  return null;
}
