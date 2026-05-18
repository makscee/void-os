import { test, expect } from "bun:test";
import { createRenderer } from "../lib/stream-render";

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: {
      write: (s: string) => {
        out.push(s);
        return true;
      },
      isTTY: false,
    },
    stderr: {
      write: (s: string) => {
        err.push(s);
        return true;
      },
      isTTY: false,
    },
  };
}

test("default ask mode: tools live, text buffered until run_end", () => {
  const io = collect();
  const r = createRenderer({ mode: "ask-buffered", stdout: io.stdout, stderr: io.stderr });
  r.handle({ event: "text", data: { text: "hello " } });
  r.handle({ event: "tool_use", data: { name: "vault.read", input: { path: "x.md" } } });
  r.handle({ event: "tool_result", data: { ok: true, size: 1234 } });
  r.handle({ event: "text", data: { text: "world" } });
  expect(io.out.join("")).toBe("· vault.read x.md\n  ↳ ok (1.2 KB)\n");
  r.handle({ event: "run_end", data: {} });
  expect(io.out.join("")).toBe("· vault.read x.md\n  ↳ ok (1.2 KB)\nhello world\n");
});

test("stream mode: text written as received", () => {
  const io = collect();
  const r = createRenderer({ mode: "stream", stdout: io.stdout, stderr: io.stderr });
  r.handle({ event: "text", data: { text: "hi " } });
  r.handle({ event: "text", data: { text: "there" } });
  expect(io.out.join("")).toBe("hi there");
});

test("tool_result error renders red line", () => {
  const io = collect();
  const r = createRenderer({ mode: "stream", stdout: io.stdout, stderr: io.stderr });
  r.handle({ event: "tool_use", data: { name: "bash", input: { cmd: "uname" } } });
  r.handle({ event: "tool_result", data: { ok: false, error: "command not found" } });
  expect(io.out.join("")).toBe("· bash uname\n  ↳ error: command not found\n");
});

test("flushBuffer drains pending text (for abnormal termination)", () => {
  const io = collect();
  const r = createRenderer({ mode: "ask-buffered", stdout: io.stdout, stderr: io.stderr });
  r.handle({ event: "text", data: { text: "partial" } });
  expect(io.out.join("")).toBe("");
  r.flushBuffer();
  expect(io.out.join("")).toBe("partial\n");
});

test("verbose: raw JSON to stderr per frame", () => {
  const io = collect();
  const r = createRenderer({
    mode: "stream",
    verbose: true,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  r.handle({ event: "text", data: { text: "x" } });
  expect(io.err.join("")).toContain(`"event":"text"`);
});

test("tolerates extra run_id field on every data payload (daemon emits it)", () => {
  const io = collect();
  const r = createRenderer({ mode: "stream", stdout: io.stdout, stderr: io.stderr });
  r.handle({ event: "text", data: { text: "hi", run_id: "r_1" } });
  r.handle({
    event: "tool_use",
    data: { name: "bash", input: { cmd: "ls" }, run_id: "r_1" },
  });
  r.handle({ event: "tool_result", data: { ok: true, run_id: "r_1" } });
  expect(io.out.join("")).toBe("hi· bash ls\n  ↳ ok\n");
});

test("error frame: stream mode writes message to stderr", () => {
  const io = collect();
  const r = createRenderer({ mode: "stream", stdout: io.stdout, stderr: io.stderr });
  r.handle({ event: "error", data: { message: "tool crashed", run_id: "r_9" } });
  expect(io.err.join("")).toContain("error: tool crashed");
  expect(io.err.join("")).toContain("r_9");
});

test("error frame: ask-buffered mode flushes pending text + writes stderr", () => {
  const io = collect();
  const r = createRenderer({ mode: "ask-buffered", stdout: io.stdout, stderr: io.stderr });
  r.handle({ event: "text", data: { text: "partial answer" } });
  r.handle({ event: "error", data: { message: "boom" } });
  // Buffered text flushed to stdout before the error appears on stderr.
  expect(io.out.join("")).toBe("partial answer\n");
  expect(io.err.join("")).toContain("error: boom");
});

test("ANSI escapes emitted when stdout isTTY=true; suppressed when isTTY=false", () => {
  const ttyOut: string[] = [];
  const ttyIo = {
    stdout: {
      write: (s: string) => {
        ttyOut.push(s);
        return true;
      },
      isTTY: true,
    },
    stderr: {
      write: () => true,
      isTTY: false,
    },
  };
  const r = createRenderer({ mode: "stream", stdout: ttyIo.stdout, stderr: ttyIo.stderr });
  r.handle({ event: "tool_use", data: { name: "x", input: {} } });
  // dim wraps with \x1b[2m...\x1b[0m
  expect(ttyOut.join("")).toContain("\x1b[2m");
  expect(ttyOut.join("")).toContain("\x1b[0m");

  const plainIo = collect();
  const r2 = createRenderer({ mode: "stream", stdout: plainIo.stdout, stderr: plainIo.stderr });
  r2.handle({ event: "tool_use", data: { name: "x", input: {} } });
  expect(plainIo.out.join("")).not.toContain("\x1b[");
});
