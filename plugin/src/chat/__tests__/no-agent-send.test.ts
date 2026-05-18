import { describe, test, expect, mock } from "bun:test";
import { ensureChat, NO_AGENT_TOAST_COPY } from "../runtime";
import { ApiError } from "../api";

describe("ensureChat no-agent UX (VOS-126)", () => {
  test("createChat 400 E_INVALID_BODY → ok:false, toast fires, chatIdRef untouched", async () => {
    const createChat = mock(() =>
      Promise.reject(
        new ApiError(400, {
          error: "E_INVALID_BODY",
          message: "agent is required",
        }, "agent is required"),
      ),
    );
    const onComposerToast = mock((_: string) => {});
    const onChatIdMinted = mock(async (_: string) => {});

    const deps = {
      api: { createChat } as unknown as Parameters<typeof ensureChat>[0]["api"],
      defaultAgent: undefined,
      onChatIdMinted,
      onComposerToast,
    };
    const chatIdRef: { current: string | null } = { current: null };
    const dispatch = mock((_: unknown) => {});

    const result = await ensureChat(deps, chatIdRef, dispatch);

    expect(createChat).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, reason: "no_agent" });
    expect(onComposerToast).toHaveBeenCalledTimes(1);
    expect(onComposerToast).toHaveBeenCalledWith(NO_AGENT_TOAST_COPY);
    expect(chatIdRef.current).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(onChatIdMinted).not.toHaveBeenCalled();
  });
});
