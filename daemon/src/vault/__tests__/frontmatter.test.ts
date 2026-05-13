import { test, expect } from 'bun:test';
import { parseFm, stringifyFm } from '../frontmatter';

test('parseFm extracts data + body', () => {
  const { data, body } = parseFm(`---\ntitle: t\ntags: [a, b]\n---\n\nhello\n`);
  expect(data.title).toBe('t');
  expect(data.tags).toEqual(['a', 'b']);
  expect(body).toBe('\nhello\n');
});

test('parseFm on file without frontmatter', () => {
  const { data, body } = parseFm(`# Heading\nbody\n`);
  expect(data).toEqual({});
  expect(body).toBe('# Heading\nbody\n');
});

test('stringifyFm round-trips when frontmatter exists', () => {
  const src = `---\ntitle: t\n---\nbody\n`;
  const { data, body } = parseFm(src);
  data.title = 't2';
  const out = stringifyFm(data, body);
  expect(parseFm(out).data.title).toBe('t2');
  expect(parseFm(out).body).toBe('body\n');
});

test('stringifyFm creates frontmatter when none existed', () => {
  const { data, body } = parseFm(`hello\n`);
  data.tags = ['x', 'y'];
  const out = stringifyFm(data, body);
  expect(out).toMatch(/^---\n/);
  expect(parseFm(out).data.tags).toEqual(['x', 'y']);
  expect(parseFm(out).body.trimEnd()).toBe('hello');
});

test('stringifyFm preserves non-string values without hand-rolling', () => {
  const { data, body } = parseFm('content\n');
  data.count = 42;
  data.enabled = true;
  data.nested = { a: 1 };
  const out = stringifyFm(data, body);
  const r = parseFm(out);
  expect(r.data.count).toBe(42);
  expect(r.data.enabled).toBe(true);
  expect(r.data.nested).toEqual({ a: 1 });
});
