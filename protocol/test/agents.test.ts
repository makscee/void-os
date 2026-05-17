import { test, expect } from "bun:test";
import { AgentListEntry, AgentsListResp } from "../src/agents.ts";

test("AgentListEntry accepts daemon row", () => {
  expect(() => AgentListEntry.parse({ name: "maya", description: "default agent" })).not.toThrow();
});

test("AgentListEntry allows empty description", () => {
  expect(() => AgentListEntry.parse({ name: "x", description: "" })).not.toThrow();
});

test("AgentListEntry rejects missing name", () => {
  expect(() => AgentListEntry.parse({ description: "x" })).toThrow();
});

test("AgentsListResp wraps a list", () => {
  expect(() => AgentsListResp.parse({ agents: [{ name: "a", description: "" }] })).not.toThrow();
  expect(() => AgentsListResp.parse({ agents: [] })).not.toThrow();
});

test("AgentsListResp rejects non-array agents", () => {
  expect(() => AgentsListResp.parse({ agents: "no" })).toThrow();
});
