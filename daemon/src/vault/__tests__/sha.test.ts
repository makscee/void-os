import { test, expect } from 'bun:test';
import { sha256Hex } from '../sha';

test('sha256Hex of empty string', () => {
  expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256Hex of "hello"', () => {
  expect(sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('sha256Hex accepts Buffer/Uint8Array', () => {
  expect(sha256Hex(new TextEncoder().encode('hello'))).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});
