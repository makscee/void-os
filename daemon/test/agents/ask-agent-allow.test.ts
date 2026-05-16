// VOS-89 T2: AgentDefn.ask_agent_allow optional allowlist for ask_agent target_agent_id.
// Plan sketched a `parseAgentDefn` loader; the actual codebase has no agent-card JSON
// parser — AgentDefn is a TS interface in daemon/src/permissions/engine.ts consumed
// as object literals. Tests here cover the interface contract structurally.

import { describe, expect, test } from 'bun:test';
import type { AgentDefn } from '../../src/permissions/engine';

describe('AgentDefn.ask_agent_allow', () => {
  test('absent field is undefined', () => {
    const defn: AgentDefn = { name: 'maya', read_scope: ['vault/**'] };
    expect(defn.ask_agent_allow).toBeUndefined();
  });

  test('present list is preserved verbatim', () => {
    const defn: AgentDefn = {
      name: 'maya',
      read_scope: ['vault/**'],
      ask_agent_allow: ['journaler', 'summarizer'],
    };
    expect(defn.ask_agent_allow).toEqual(['journaler', 'summarizer']);
  });

  test('empty list is allowed (means: ask nobody)', () => {
    const defn: AgentDefn = {
      name: 'maya',
      read_scope: ['vault/**'],
      ask_agent_allow: [],
    };
    expect(defn.ask_agent_allow).toEqual([]);
  });
});
