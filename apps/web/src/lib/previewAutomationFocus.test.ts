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

const setupDocument = (activeElement: MockHTMLElement | null) => {
  const body = new MockHTMLElement();
  const documentElement = new MockHTMLElement();
  vi.stubGlobal("HTMLElement", MockHTMLElement);
  vi.stubGlobal("document", {
    activeElement,
    body,
    documentElement,
  });
  return { body, documentElement };
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

  it("does not restore a detached prior element", async () => {
    const composer = new MockHTMLElement();
    const { body } = setupDocument(composer);

    await withPreviewAutomationFocus(async () => {
      composer.isConnected = false;
      setActiveElement(body);
    });

    expect(composer.focus).not.toHaveBeenCalled();
  });

  it("restores focus when automation moves it to another connected element", async () => {
    const composer = new MockHTMLElement();
    const previewControl = new MockHTMLElement();
    setupDocument(composer);

    await withPreviewAutomationFocus(async () => {
      setActiveElement(previewControl);
    });

    expect(composer.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(globalThis.document.activeElement).toBe(composer);
  });
});
