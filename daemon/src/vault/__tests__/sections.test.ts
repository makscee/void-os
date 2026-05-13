import { test, expect } from 'bun:test';
import { findSection } from '../sections';

const doc = `---
title: t
---

# Title

## Alpha
alpha body line 1
alpha body line 2

## Beta
beta body
`;

test('finds section between heading and next ##', () => {
  const r = findSection(doc, 'Alpha');
  expect(r).not.toBeNull();
  expect(doc.slice(r!.bodyStart, r!.bodyEnd)).toBe('alpha body line 1\nalpha body line 2\n\n');
});

test('finds last section to EOF', () => {
  const r = findSection(doc, 'Beta');
  expect(r).not.toBeNull();
  expect(doc.slice(r!.bodyStart, r!.bodyEnd)).toBe('beta body\n');
});

test('returns null when heading absent', () => {
  expect(findSection(doc, 'Gamma')).toBeNull();
});

test('ignores ## inside frontmatter', () => {
  const tricky = `---
title: "## not a section"
---

## Real
body
`;
  const r = findSection(tricky, 'Real');
  expect(r).not.toBeNull();
  expect(tricky.slice(r!.bodyStart, r!.bodyEnd)).toBe('body\n');
});

test('matches heading exactly (## A vs ## Alpha)', () => {
  const d = '## A\nx\n## Alpha\ny\n';
  const r = findSection(d, 'A');
  expect(d.slice(r!.bodyStart, r!.bodyEnd)).toBe('x\n');
});

test('empty section body', () => {
  const d = '## Empty\n## Next\nbody\n';
  const r = findSection(d, 'Empty');
  expect(d.slice(r!.bodyStart, r!.bodyEnd)).toBe('');
});

test('### subsection inside section does not terminate', () => {
  const d = '## A\nintro\n### Sub\nsub body\n## B\nb\n';
  const r = findSection(d, 'A');
  expect(d.slice(r!.bodyStart, r!.bodyEnd)).toBe('intro\n### Sub\nsub body\n');
});
