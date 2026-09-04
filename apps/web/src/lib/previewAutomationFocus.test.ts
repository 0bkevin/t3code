import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { withPreviewAutomationFocus } from "./previewAutomationFocus";

class MockHTMLElement {
  isConnected = true;
  readonly focus = vi.fn((_options?: FocusOptions) => {
    setActiveElement(this);
  });
}

const setActiveElement = (activeElement: MockHTMLElement | null): void => {
  (globalThis.document as unknown as { activeElement: MockHTMLElement | null }).activeElement =
    activeElement;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const setupDocument = (activeElement: MockHTMLElement | null, initiallyFocused = true) => {
  const body = new MockHTMLElement();
  const documentElement = new MockHTMLElement();
  let focused = initiallyFocused;
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const windowListeners = new Map<string, Set<() => void>>();
  vi.stubGlobal("HTMLElement", MockHTMLElement);
  vi.stubGlobal("document", {
    activeElement,
    body,
    documentElement,
    hasFocus: () => focused,
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const typeListeners = listeners.get(type) ?? new Set();
      typeListeners.add(listener);
      listeners.set(type, typeListeners);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
  });
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: () => void) => {
      const typeListeners = windowListeners.get(type) ?? new Set();
      typeListeners.add(listener);
      windowListeners.set(type, typeListeners);
    },
    removeEventListener: (type: string, listener: () => void) => {
      windowListeners.get(type)?.delete(listener);
    },
  });
  return {
    body,
    documentElement,
    setFocused: (value: boolean) => (focused = value),
    dispatch: (type: string, target: MockHTMLElement, isTrusted = true) => {
      for (const listener of listeners.get(type) ?? []) {
        listener({ target, isTrusted } as unknown as Event);
      }
    },
    dispatchWindow: (type: string) => {
      for (const listener of windowListeners.get(type) ?? []) listener();
    },
  };
};

describe("withPreviewAutomationFocus", () => {
  it("restores connected focus when automation leaves no meaningful active element", async () => {
    const composer = new MockHTMLElement();
    const { body } = setupDocument(composer);

    const result = await withPreviewAutomationFocus(async () => {
      setActiveElement(body);
      return "pressed";
    });

    expect(result).toBe("pressed");
    expect(composer.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(globalThis.document.activeElement).toBe(composer);
  });

  it("restores focus on failure without replacing the original rejection", async () => {
    const composer = new MockHTMLElement();
    const { body } = setupDocument(composer);
    const error = new Error("press failed");

    await expect(
      withPreviewAutomationFocus(async () => {
        setActiveElement(body);
        throw error;
      }),
    ).rejects.toBe(error);

    expect(composer.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("does not mask the operation rejection when restoration fails", async () => {
    const composer = new MockHTMLElement();
    const { body } = setupDocument(composer);
    const error = new Error("press failed");
    composer.focus.mockImplementation(() => {
      throw new Error("focus failed");
    });

    await expect(
      withPreviewAutomationFocus(async () => {
        setActiveElement(body);
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it("does not mask the operation result when restoration fails", async () => {
    const composer = new MockHTMLElement();
    const { body } = setupDocument(composer);
    composer.focus.mockImplementation(() => {
      throw new Error("focus failed");
    });

    await expect(
      withPreviewAutomationFocus(async () => {
        setActiveElement(body);
        return "pressed";
      }),
    ).resolves.toBe("pressed");
  });

  it("skips restoration for an interrupted automation result", async () => {
    const composer = new MockHTMLElement();
    const hostButton = new MockHTMLElement();
    setupDocument(composer);

    const result = await withPreviewAutomationFocus<{ status: "completed" | "interrupted" }>(
      async () => {
        setActiveElement(hostButton);
        return { status: "interrupted" as const };
      },
      { shouldRestoreFocus: (value) => value.status === "completed" },
    );

    expect(result).toEqual({ status: "interrupted" });
    expect(composer.focus).not.toHaveBeenCalled();
    expect(globalThis.document.activeElement).toBe(hostButton);
  });

  it("skips restoration when native automation preserves focus", async () => {
    const composer = new MockHTMLElement();
    const hostButton = new MockHTMLElement();
    setupDocument(composer);

    const result = await withPreviewAutomationFocus<{
      readonly status: "completed";
      readonly focusDisposition: "preserved" | "restored";
    }>(
      async () => {
        setActiveElement(hostButton);
        return { status: "completed" as const, focusDisposition: "preserved" as const };
      },
      {
        shouldRestoreFocus: (value) =>
          value.status === "completed" && value.focusDisposition === "restored",
      },
    );

    expect(result).toEqual({ status: "completed", focusDisposition: "preserved" });
    expect(composer.focus).not.toHaveBeenCalled();
    expect(globalThis.document.activeElement).toBe(hostButton);
  });

  it("restores connected focus when native automation reports restoration", async () => {
    const composer = new MockHTMLElement();
    const hostButton = new MockHTMLElement();
    setupDocument(composer);

    await withPreviewAutomationFocus(
      async () => {
        setActiveElement(hostButton);
        return { status: "completed" as const, focusDisposition: "restored" as const };
      },
      {
        shouldRestoreFocus: (value) =>
          value.status === "completed" && value.focusDisposition === "restored",
      },
    );

    expect(composer.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(globalThis.document.activeElement).toBe(composer);
  });

  it("does not restore a detached prior element", async () => {
    const composer = new MockHTMLElement();
    const { body } = setupDocument(composer);

    await withPreviewAutomationFocus(async () => {
      composer.isConnected = false;
      setActiveElement(body);
    });

    expect(composer.focus).not.toHaveBeenCalled();
  });

  it("restores focus when automation moves to a connected host button", async () => {
    const composer = new MockHTMLElement();
    const hostButton = new MockHTMLElement();
    const { dispatch, dispatchWindow } = setupDocument(composer);

    await withPreviewAutomationFocus(async () => {
      dispatchWindow("blur");
      dispatchWindow("focus");
      setActiveElement(hostButton);
      dispatch("focusin", hostButton);
    });

    expect(composer.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(globalThis.document.activeElement).toBe(composer);
  });

  it("preserves pointer focus into the same connected host button", async () => {
    const composer = new MockHTMLElement();
    const hostButton = new MockHTMLElement();
    const { dispatch } = setupDocument(composer);

    await withPreviewAutomationFocus(async () => {
      dispatch("pointerdown", hostButton);
      setActiveElement(hostButton);
      dispatch("focusin", hostButton);
    });

    expect(composer.focus).not.toHaveBeenCalled();
    expect(globalThis.document.activeElement).toBe(hostButton);
  });

  it("preserves keyboard focus into the same connected host button", async () => {
    const composer = new MockHTMLElement();
    const hostButton = new MockHTMLElement();
    const { dispatch } = setupDocument(composer);

    await withPreviewAutomationFocus(async () => {
      dispatch("keydown", composer);
      setActiveElement(hostButton);
      dispatch("focusin", hostButton);
    });

    expect(composer.focus).not.toHaveBeenCalled();
    expect(globalThis.document.activeElement).toBe(hostButton);
  });

  it("preserves pointer focus into the preview", async () => {
    const composer = new MockHTMLElement();
    const previewElement = new MockHTMLElement();
    const { dispatch } = setupDocument(composer);

    await withPreviewAutomationFocus(async () => {
      dispatch("pointerdown", previewElement);
      setActiveElement(previewElement);
      dispatch("focusin", previewElement);
    });

    expect(composer.focus).not.toHaveBeenCalled();
    expect(globalThis.document.activeElement).toBe(previewElement);
  });

  it("preserves trusted programmatic-like focus without a native window transfer", async () => {
    const composer = new MockHTMLElement();
    const previewElement = new MockHTMLElement();
    const { dispatch } = setupDocument(composer);

    await withPreviewAutomationFocus(async () => {
      setActiveElement(previewElement);
      // Chromium emits trusted focusin for HTMLElement.focus(), just like a
      // native focus transition without an accompanying pointer or key event.
      dispatch("focusin", previewElement);
    });

    expect(composer.focus).not.toHaveBeenCalled();
    expect(globalThis.document.activeElement).toBe(previewElement);
  });

  it("ignores synthetic pointer and keyboard input as user intent", async () => {
    const composer = new MockHTMLElement();
    const hostButton = new MockHTMLElement();
    const { dispatch, dispatchWindow } = setupDocument(composer);

    await withPreviewAutomationFocus(async () => {
      dispatch("pointerdown", hostButton, false);
      dispatch("keydown", composer, false);
      dispatchWindow("blur");
      dispatchWindow("focus");
      setActiveElement(hostButton);
      dispatch("focusin", hostButton);
    });

    expect(composer.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(globalThis.document.activeElement).toBe(composer);
  });

  it("expires user intent when a pointer does not focus its target", async () => {
    const composer = new MockHTMLElement();
    const nonFocusableTarget = new MockHTMLElement();
    const hostButton = new MockHTMLElement();
    const { dispatch, dispatchWindow } = setupDocument(composer);

    await withPreviewAutomationFocus(async () => {
      dispatch("pointerdown", nonFocusableTarget);
      await Promise.resolve();
      dispatchWindow("blur");
      dispatchWindow("focus");
      setActiveElement(hostButton);
    });

    expect(composer.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(globalThis.document.activeElement).toBe(composer);
  });

  it("does not replace newer user focus while automation is pending", async () => {
    const composer = new MockHTMLElement();
    const { body, dispatch } = setupDocument(composer);
    const newerControl = new MockHTMLElement();
    let finishOperation!: () => void;
    let operationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      operationStarted = resolve;
    });

    const pending = withPreviewAutomationFocus(async () => {
      setActiveElement(body);
      operationStarted();
      await new Promise<void>((resolve) => {
        finishOperation = resolve;
      });
    });

    await started;
    dispatch("focusin", newerControl, false);
    setActiveElement(newerControl);
    finishOperation();
    await pending;

    expect(composer.focus).not.toHaveBeenCalled();
    expect(globalThis.document.activeElement).toBe(newerControl);
  });

  it("skips restoration when the document is not focused at the start", async () => {
    const composer = new MockHTMLElement();
    const { body } = setupDocument(composer, false);

    await withPreviewAutomationFocus(async () => {
      setActiveElement(body);
    });

    expect(composer.focus).not.toHaveBeenCalled();
  });

  it("skips restoration when the document is not focused at completion", async () => {
    const composer = new MockHTMLElement();
    const { body, setFocused } = setupDocument(composer);

    await withPreviewAutomationFocus(async () => {
      setActiveElement(body);
      setFocused(false);
    });

    expect(composer.focus).not.toHaveBeenCalled();
  });

  it("does not let an older thread restore over a newer transaction", async () => {
    const firstComposer = new MockHTMLElement();
    const { body } = setupDocument(firstComposer);
    let firstStarted!: () => void;
    let finishFirst!: () => void;
    let secondStarted!: () => void;
    let finishSecond!: () => void;
    const firstHasFocus = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstDone = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const secondDone = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const secondHasFocus = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });

    const first = withPreviewAutomationFocus(async () => {
      setActiveElement(body);
      firstStarted();
      await firstDone;
    });

    await firstHasFocus;
    const second = withPreviewAutomationFocus(async () => {
      setActiveElement(body);
      secondStarted();
      await secondDone;
    });

    finishFirst();
    await first;

    expect(firstComposer.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(globalThis.document.activeElement).toBe(firstComposer);

    await secondHasFocus;
    expect(globalThis.document.activeElement).toBe(body);
    finishSecond();
    await second;

    expect(firstComposer.focus).toHaveBeenCalledTimes(2);
    expect(globalThis.document.activeElement).toBe(firstComposer);
  });
});
