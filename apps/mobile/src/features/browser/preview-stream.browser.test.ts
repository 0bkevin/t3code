// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { PreviewStreamControl } from "@t3tools/client-runtime/preview/server-browser-stream";

import { start, stop } from "./preview-stream.browser";

class Socket extends EventTarget {
  static readonly OPEN = 1;
  static current: Socket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  constructor() {
    super();
    Socket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  control(value: PreviewStreamControl) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "control", ...value }),
      }),
    );
  }
}

afterEach(() => {
  stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

it("keeps typing focused across automatic return, but clears input when interaction is denied", async () => {
  vi.useFakeTimers();
  window.ReactNativeWebView = { postMessage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 390, 844),
  );
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly notify: () => void) {}
      observe() {
        this.notify();
      }
      disconnect() {}
    },
  );
  start({
    access: {
      httpBase: "https://preview.test",
      wsBase: "wss://preview.test",
      credentials: false,
      query: {},
    },
    threadId: "thread",
    tabId: "tab",
    interactive: true,
    automaticControl: true,
    background: "white",
  });
  await vi.advanceTimersByTimeAsync(0);
  const socket = Socket.current;
  const control: PreviewStreamControl = {
    canOperate: true,
    automaticControlSupported: true,
    controller: "you",
    generation: 1,
    dialog: null,
  };
  const input = document.querySelector("textarea")!;
  socket.control(control);
  input.focus();
  input.value = "unfinished input";
  socket.control({ ...control, controller: "agent", generation: 2 });
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("unfinished input");
  input.dispatchEvent(new InputEvent("input"));
  expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
    type: "text",
    text: "unfinished input",
    automaticControl: true,
  });

  for (const denied of [
    { ...control, controller: "another-viewer" as const },
    { ...control, canOperate: false },
  ]) {
    socket.control(control);
    input.focus();
    input.value = "discard this input";
    socket.control(denied);
    expect(input.value).not.toBe("discard this input");
    expect(input.disabled).toBe(true);
  }
});
