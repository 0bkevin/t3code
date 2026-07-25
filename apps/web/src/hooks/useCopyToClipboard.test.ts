import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ClipboardApiUnavailableError,
  ClipboardWriteError,
  writeTextToClipboard,
} from "./useCopyToClipboard";

describe("writeTextToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports unavailable clipboard support with structural context", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});

    const error = await writeTextToClipboard("plan contents", "plan").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ClipboardApiUnavailableError);
    expect(error).toMatchObject({
      target: "plan",
    });
    expect((error as Error).message).not.toContain("plan contents");
  });

  it("preserves the exact clipboard failure without exposing copied contents", async () => {
    const cause = new Error("browser clipboard failure");
    const writeText = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const error = await writeTextToClipboard("secret clipboard contents", "error-message").then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(writeText).toHaveBeenCalledWith("secret clipboard contents");
    expect(error).toBeInstanceOf(ClipboardWriteError);
    expect(error).toMatchObject({
      target: "error-message",
      cause,
    });
    expect((error as Error).message).not.toContain("secret clipboard contents");
  });

  it("keeps empty values as a no-op when clipboard support is available", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(writeTextToClipboard("", "plan")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  // `navigator.clipboard` only exists in a secure context, so it is undefined
  // over plain http — which is how T3 is reached on a LAN or Tailscale host.
  // Without the legacy fallback every copy button on such an origin silently
  // does nothing, including the one handing over a pairing command.
  it("falls back to execCommand in an insecure context", async () => {
    const execCommand = vi.fn(() => true);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    const appended: Array<Record<string, unknown>> = [];
    const makeElement = () => {
      const element: Record<string, unknown> = {
        style: {},
        value: "",
        setAttribute: () => {},
        select: () => {},
        setSelectionRange: () => {},
        remove: () => {},
      };
      return element;
    };
    vi.stubGlobal("document", {
      createElement: () => {
        const element = makeElement();
        appended.push(element);
        return element;
      },
      body: { appendChild: () => {} },
      activeElement: null,
      execCommand,
    });

    await expect(writeTextToClipboard("hermes t3 connect --url x", "command")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back to execCommand when a secure-context write is rejected", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    const execCommand = vi.fn(() => true);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const appended: Array<Record<string, unknown>> = [];
    const makeElement = () => {
      const element: Record<string, unknown> = {
        style: {},
        value: "",
        setAttribute: () => {},
        select: () => {},
        setSelectionRange: () => {},
        remove: () => {},
      };
      return element;
    };
    vi.stubGlobal("document", {
      createElement: () => {
        const element = makeElement();
        appended.push(element);
        return element;
      },
      body: { appendChild: () => {} },
      activeElement: null,
      execCommand,
    });

    await expect(writeTextToClipboard("value", "command")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });
});
