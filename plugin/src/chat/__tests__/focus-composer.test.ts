import { describe, test, expect, mock } from "bun:test";
import {
  focusComposerInputSafely,
  type FocusComposerDoc,
  type FocusableTextArea,
} from "../focus-composer";

function makeDoc(hasModal: boolean): FocusComposerDoc {
  return {
    querySelector: (sel: string) => {
      // Only `.modal-container` is consulted by the helper; anything else
      // returning null is fine.
      if (sel === ".modal-container") return hasModal ? {} : null;
      return null;
    },
  };
}

describe("focusComposerInputSafely (VOS-151)", () => {
  test("focuses textarea when no modal is open, passes preventScroll: true", () => {
    const focus = mock((_opts?: { preventScroll?: boolean }) => {});
    const ta: FocusableTextArea = { focus };
    const doc = makeDoc(false);

    const ok = focusComposerInputSafely(ta, doc);

    expect(ok).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  test("skips focus when .modal-container is present in document", () => {
    const focus = mock(() => {});
    const ta: FocusableTextArea = { focus };
    const doc = makeDoc(true);

    const ok = focusComposerInputSafely(ta, doc);

    expect(ok).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  test("no-op on null textarea", () => {
    const doc = makeDoc(false);
    expect(focusComposerInputSafely(null, doc)).toBe(false);
    expect(focusComposerInputSafely(undefined, doc)).toBe(false);
  });
});
