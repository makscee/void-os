// VOS-82: A2A v1.0 type + schema conformance tests.
//
// Coverage:
//   1. Compile-time: a fully-populated AgentCard, Task, and Message satisfy
//      the hand-written types in ../a2a.ts.
//   2. Runtime round-trip: parse a JSON payload through MessageSchema /
//      TaskSchema, re-serialize via JSON.stringify, and assert equality
//      against the original input (deep-equal via parsed JSON).
//   3. Negative: PartSchema rejects payloads that set more than one of
//      {text, raw, url, data} (the v1.0 member-name discriminator MUST
//      be exactly-one-of).

import { describe, expect, test } from "bun:test";
import type {
  AgentCard,
  Message,
  Part,
  Task,
} from "../a2a";
import { Role, TaskState } from "../a2a";
import {
  MessageSchema,
  PartSchema,
  TaskSchema,
} from "../a2a.zod";

describe("A2A v1.0 — TS type structural conformance", () => {
  test("AgentCard literal compiles with all required fields", () => {
    const card: AgentCard = {
      name: "Test Agent",
      description: "A test agent",
      version: "1.0.0",
      capabilities: { streaming: true },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      supportedInterfaces: [
        {
          url: "https://example.com/a2a/v1",
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        },
      ],
      skills: [
        {
          id: "skill-1",
          name: "Echo",
          description: "Echoes input back.",
          tags: ["demo"],
        },
      ],
    };
    expect(card.name).toBe("Test Agent");
    expect(card.supportedInterfaces[0]?.protocolBinding).toBe("JSONRPC");
  });

  test("Task + TaskStatus + Artifact literal compiles", () => {
    const task: Task = {
      id: "task-1",
      contextId: "ctx-1",
      status: { state: TaskState.Working, timestamp: "2026-05-15T12:00:00Z" },
      artifacts: [
        {
          artifactId: "art-1",
          parts: [{ text: "Result" }],
        },
      ],
    };
    expect(task.status.state).toBe("TASK_STATE_WORKING");
  });

  test("Message literal compiles with TextPart and DataPart", () => {
    const parts: Part[] = [
      { text: "Hello" },
      { data: { foo: 1 } },
    ];
    const msg: Message = {
      messageId: "m-1",
      role: Role.User,
      parts,
    };
    expect(msg.role).toBe("ROLE_USER");
    expect(msg.parts).toHaveLength(2);
  });
});

describe("A2A v1.0 — Zod round-trip", () => {
  test("Message JSON round-trips through MessageSchema", () => {
    const input = {
      messageId: "m-42",
      role: "ROLE_USER",
      parts: [
        { text: "Hello, world!" },
        { raw: "iVBORw0KGgo=", filename: "img.png", mediaType: "image/png" },
      ],
      contextId: "ctx-42",
      metadata: { source: "test" },
    };
    const parsed = MessageSchema.parse(input);
    // Stringify both and compare structurally — Zod leaves shape intact.
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(input);
  });

  test("Task with status + artifact round-trips through TaskSchema", () => {
    const input = {
      id: "task-7",
      contextId: "ctx-7",
      status: {
        state: "TASK_STATE_COMPLETED",
        timestamp: "2026-05-15T12:34:56Z",
      },
      artifacts: [
        {
          artifactId: "art-7",
          parts: [{ text: "Done." }, { data: { score: 0.95 } }],
          name: "summary",
        },
      ],
    };
    const parsed = TaskSchema.parse(input);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(input);
  });
});

describe("A2A v1.0 — PartSchema member-name exclusivity", () => {
  test("rejects {text, raw} simultaneously set", () => {
    const bad = { text: "x", raw: "y" };
    expect(() => PartSchema.parse(bad)).toThrow();
  });

  test("rejects {text, data} simultaneously set", () => {
    const bad = { text: "x", data: { k: 1 } };
    expect(() => PartSchema.parse(bad)).toThrow();
  });

  test("rejects {raw, url} simultaneously set", () => {
    const bad = { raw: "x", url: "https://example.com/f" };
    expect(() => PartSchema.parse(bad)).toThrow();
  });

  test("PartSchema rejects empty object (no discriminator)", () => {
    expect(() => PartSchema.parse({})).toThrow();
  });

  test("accepts each variant individually", () => {
    expect(() => PartSchema.parse({ text: "ok" })).not.toThrow();
    expect(() =>
      PartSchema.parse({ raw: "QUJD", filename: "a.bin", mediaType: "application/octet-stream" }),
    ).not.toThrow();
    expect(() => PartSchema.parse({ url: "https://example.com/a" })).not.toThrow();
    expect(() => PartSchema.parse({ data: { k: 1 } })).not.toThrow();
  });
});
