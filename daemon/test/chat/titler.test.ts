import { test, expect, mock } from "bun:test";
import { makeTitler, type ChatRepoLike } from "../../src/chat/titler";

type StoredChat = { id: string; title: string | null; session_id: string | null };

function makeMockRepo(initial: StoredChat): ChatRepoLike & {
  store: StoredChat;
  setTitleCalls: number;
} {
  const store = { ...initial };
  let setTitleCalls = 0;
  return {
    store,
    get setTitleCalls() {
      return setTitleCalls;
    },
    get(id: string) {
      return id === store.id ? { ...store } : null;
    },
    setTitle(id: string, title: string) {
      if (id !== store.id) return false;
      if (store.title !== null) return false; // idempotent guard at repo level
      store.title = title;
      setTitleCalls++;
      return true;
    },
  };
}

const HAIKU_OK = {
  content: [{ type: "text", text: "A nice chat title" }],
};

test("titler calls SDK once and sets title on first turn", async () => {
  const repo = makeMockRepo({ id: "c1", title: null, session_id: "sid-1" });
  const sdkCreate = mock(async () => HAIKU_OK);
  const sdk = { messages: { create: sdkCreate } };
  const replay = {
    walk: () =>
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hey" },
      ] as const,
  };
  const emitted: Array<{ t: string; p: any }> = [];
  const titler = makeTitler({
    repo,
    sdk: sdk as any,
    replay: replay as any,
    emit: (t, p) => emitted.push({ t, p }),
  });

  await titler.title("c1");

  expect(repo.store.title).toBe("A nice chat title");
  expect(sdkCreate).toHaveBeenCalledTimes(1);
  expect(emitted.find((e) => e.t === "chat.title")).toEqual({
    t: "chat.title",
    p: { chat_id: "c1", title: "A nice chat title" },
  });

  // Verify model id is Haiku 4.5
  const args = (sdkCreate.mock.calls as any[])[0][0] as any;
  expect(args.model).toBe("claude-haiku-4-5-20251001");
  expect(typeof args.system).toBe("string");
  expect(Array.isArray(args.messages)).toBe(true);
});

test("titler skips SDK if title already set (idempotent)", async () => {
  const repo = makeMockRepo({ id: "c1", title: "Existing", session_id: "sid-1" });
  const sdkCreate = mock(async () => HAIKU_OK);
  const sdk = { messages: { create: sdkCreate } };
  const replay = { walk: () => [] };
  const emitted: Array<{ t: string; p: any }> = [];
  const titler = makeTitler({
    repo,
    sdk: sdk as any,
    replay: replay as any,
    emit: (t, p) => emitted.push({ t, p }),
  });

  await titler.title("c1");

  expect(sdkCreate).toHaveBeenCalledTimes(0);
  expect(repo.store.title).toBe("Existing");
  expect(emitted).toEqual([]);
});

test("titler skips SDK if chat has no session_id yet (pre-first-turn)", async () => {
  const repo = makeMockRepo({ id: "c1", title: null, session_id: null });
  const sdkCreate = mock(async () => HAIKU_OK);
  const titler = makeTitler({
    repo,
    sdk: { messages: { create: sdkCreate } } as any,
    replay: { walk: () => [] } as any,
    emit: () => {},
  });
  await titler.title("c1");
  expect(sdkCreate).toHaveBeenCalledTimes(0);
  expect(repo.store.title).toBeNull();
});

test("titler skips when chat does not exist", async () => {
  const repo = makeMockRepo({ id: "c1", title: null, session_id: "sid-1" });
  const sdkCreate = mock(async () => HAIKU_OK);
  const titler = makeTitler({
    repo,
    sdk: { messages: { create: sdkCreate } } as any,
    replay: { walk: () => [] } as any,
    emit: () => {},
  });
  await titler.title("does-not-exist");
  expect(sdkCreate).toHaveBeenCalledTimes(0);
});

test("SDK error emits chat.title_failed, leaves title null, does not throw", async () => {
  const repo = makeMockRepo({ id: "c1", title: null, session_id: "sid-1" });
  const sdkCreate = mock(async () => {
    throw new Error("rate limit");
  });
  const replay = { walk: () => [{ role: "user", content: "hi" }] };
  const emitted: Array<{ t: string; p: any }> = [];
  const titler = makeTitler({
    repo,
    sdk: { messages: { create: sdkCreate } } as any,
    replay: replay as any,
    emit: (t, p) => emitted.push({ t, p }),
  });

  // Must not reject
  await titler.title("c1");

  expect(repo.store.title).toBeNull();
  const failEvt = emitted.find((e) => e.t === "chat.title_failed");
  expect(failEvt).toBeTruthy();
  expect(failEvt!.p.chat_id).toBe("c1");
  expect(failEvt!.p.error).toContain("rate limit");
});

test("empty SDK text response treated as failure", async () => {
  const repo = makeMockRepo({ id: "c1", title: null, session_id: "sid-1" });
  const sdkCreate = mock(async () => ({ content: [{ type: "text", text: "   " }] }));
  const replay = { walk: () => [{ role: "user", content: "hi" }] };
  const emitted: Array<{ t: string; p: any }> = [];
  const titler = makeTitler({
    repo,
    sdk: { messages: { create: sdkCreate } } as any,
    replay: replay as any,
    emit: (t, p) => emitted.push({ t, p }),
  });

  await titler.title("c1");

  expect(repo.store.title).toBeNull();
  expect(emitted.find((e) => e.t === "chat.title_failed")).toBeTruthy();
});

test("title is trimmed and stripped of wrapping quotes/punctuation", async () => {
  const repo = makeMockRepo({ id: "c1", title: null, session_id: "sid-1" });
  const sdkCreate = mock(async () => ({
    content: [{ type: "text", text: '  "Hello World."  ' }],
  }));
  const titler = makeTitler({
    repo,
    sdk: { messages: { create: sdkCreate } } as any,
    replay: { walk: () => [{ role: "user", content: "hi" }] } as any,
    emit: () => {},
  });
  await titler.title("c1");
  expect(repo.store.title).toBe("Hello World");
});

test("replay messages tail (last 10) is passed to SDK", async () => {
  const repo = makeMockRepo({ id: "c1", title: null, session_id: "sid-1" });
  const sdkCreate = mock(async () => HAIKU_OK);
  // 15 messages total — titler should send only last 10
  const msgs = Array.from({ length: 15 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `msg ${i}`,
  }));
  const titler = makeTitler({
    repo,
    sdk: { messages: { create: sdkCreate } } as any,
    replay: { walk: () => msgs } as any,
    emit: () => {},
  });
  await titler.title("c1");
  const args = (sdkCreate.mock.calls as any[])[0][0] as any;
  expect(args.messages.length).toBe(10);
  expect(args.messages[0].content).toBe("msg 5");
  expect(args.messages[9].content).toBe("msg 14");
});
