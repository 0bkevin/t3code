import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createPreviewStreamClient,
  type PreviewStreamControl,
  type PreviewStreamTarget,
} from "./serverBrowserStream.ts";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(value: PreviewStreamControl) {
    this.message(JSON.stringify({ type: "control", ...value }));
  }
}

const target: PreviewStreamTarget = {
  access: {
    httpBase: "http://preview.test/api/preview-stream",
    wsBase: "ws://preview.test/api/preview-stream",
    query: {},
    credentials: true,
  },
  threadId: "thread",
  tabId: "tab",
  maxWidth: 800,
  maxHeight: 600,
};

describe("preview stream control", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const connect = (streamTarget = target) => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(streamTarget, {
      onFrame,
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    return { client, socket: FakeSocket.current, onFrame, onControl };
  };
  const agent: PreviewStreamControl = {
    canOperate: true,
    automaticControlSupported: true,
    controller: "agent",
    generation: 1,
    dialog: null,
  };

  it("marks passive viewers without changing active viewer URLs", () => {
    const { client, socket } = connect();
    expect(new URL(socket.url).searchParams.has("interactive")).toBe(false);
    client.stop();
    const passive = createPreviewStreamClient(
      { ...target, interactive: false },
      {
        onFrame: vi.fn(),
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    expect(new URL(FakeSocket.current.url).searchParams.get("interactive")).toBe("false");
    passive.stop();
  });

  it("does not resize or navigate before ownership is granted", () => {
    const { client, socket } = connect();
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "navigate", url: "http://example.test" })).toBe(false);
    socket.control(agent);
    expect(client.send({ type: "takeControl" })).toBe(true);
    expect(client.send({ type: "text", text: "premature" })).toBe(false);
    socket.control({ ...agent, controller: "you", generation: 2 });
    expect(client.send({ type: "text", text: "owned" })).toBe(true);
    expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual([
      { type: "takeControl" },
      { type: "text", text: "owned" },
    ]);
    client.stop();
  });

  it("sends the first automatic gesture, including its release, before the control update", () => {
    const { client, socket } = connect({ ...target, automaticControl: true });
    socket.control(agent);

    const mouse = {
      type: "mouse",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
      modifiers: 0,
    } as const;
    const pressed = { ...mouse, action: "down", buttons: 1 } as const;
    const released = { ...mouse, action: "up", buttons: 0 } as const;
    expect(client.send(pressed)).toBe(true);
    expect(client.send(released)).toBe(true);
    expect(client.send({ ...mouse, action: "move", buttons: 0 })).toBe(false);
    expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual([
      { ...pressed, automaticControl: true },
      { ...released, automaticControl: true },
    ]);
    client.stop();
  });

  it.each([
    { type: "wheel", x: 10, y: 20, deltaX: 0, deltaY: 12, modifiers: 0 },
    { type: "key", action: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 },
    { type: "key", action: "up", key: "a", code: "KeyA", modifiers: 0 },
    { type: "text", text: "pasted or composed text" },
    { type: "probe", x: 10, y: 20 },
    { type: "dialog", accept: true },
  ] as const)("forwards automatic $type input before ownership is acknowledged", (input) => {
    const { client, socket } = connect({ ...target, automaticControl: true });
    socket.control(agent);
    expect(client.send(input)).toBe(true);
    expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual([
      { ...input, automaticControl: true },
    ]);
    client.stop();
  });

  it.each([
    { interactive: false, canOperate: true, controller: "agent" },
    { interactive: true, canOperate: false, controller: "agent" },
    { interactive: true, canOperate: true, controller: "another-viewer" },
  ] as const)(
    "refuses automatic input for $controller / operate=$canOperate / interactive=$interactive",
    ({ interactive, canOperate, controller }) => {
      const { client, socket } = connect({ ...target, automaticControl: true, interactive });
      socket.control({ ...agent, canOperate, controller });
      expect(client.send({ type: "text", text: "must not reach page" })).toBe(false);
      expect(client.send({ type: "probe", x: 1, y: 2 })).toBe(false);
      expect(socket.sent).toEqual([]);
      client.stop();
    },
  );

  it("retains the opt-in across reconnects without replaying disconnected input", () => {
    vi.useFakeTimers();
    const { client, socket } = connect({ ...target, automaticControl: true });
    socket.dispatchEvent(new Event("open"));
    socket.control(agent);
    socket.readyState = 3;
    socket.dispatchEvent(Object.assign(new Event("close"), { code: 1012 }));
    expect(client.send({ type: "text", text: "offline" })).toBe(false);
    vi.advanceTimersByTime(500);
    const reconnected = FakeSocket.current;
    expect(reconnected).not.toBe(socket);
    expect(client.send({ type: "text", text: "before status" })).toBe(false);
    reconnected.control(agent);
    expect(client.send({ type: "text", text: "fresh input" })).toBe(true);
    expect(reconnected.sent.map((entry) => JSON.parse(entry))).toEqual([
      { type: "text", text: "fresh input", automaticControl: true },
    ]);
    client.stop();
  });

  it("keeps explicit takeover for an older environment rather than dropping an automatic gesture", () => {
    const { client, socket } = connect({ ...target, automaticControl: true });
    const { automaticControlSupported: _support, ...legacy } = agent;
    socket.control(legacy);
    expect(client.send({ type: "text", text: "cannot implicitly claim" })).toBe(false);
    expect(client.send({ type: "takeControl" })).toBe(true);
    socket.control({ ...legacy, controller: "you" });
    expect(client.send({ type: "text", text: "manual takeover works" })).toBe(true);
    client.stop();
  });

  it("does not grant control from malformed dialog metadata", () => {
    const { client, socket, onControl } = connect();
    socket.message(
      JSON.stringify({
        type: "control",
        ...agent,
        controller: "you",
        dialog: { type: "prompt", message: 42, defaultValue: "" },
      }),
    );
    expect(onControl).not.toHaveBeenCalled();
    expect(client.send({ type: "reload" })).toBe(false);
    client.stop();
  });

  it("keeps read-only frames flowing while refusing takeover and every mutation", () => {
    const { client, socket, onFrame } = connect();
    socket.control({ ...agent, canOperate: false });
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenCalledWith(frame);
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "reload" })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("revokes input immediately on release and exposes pending dialog state", () => {
    const { client, socket, onControl } = connect();
    const owned = {
      ...agent,
      controller: "you" as const,
      dialog: { type: "prompt", message: "Name?", defaultValue: "initial" },
    };
    socket.control(owned);
    expect(onControl).toHaveBeenLastCalledWith(owned);
    expect(client.send({ type: "dialog", accept: true, promptText: "answer" })).toBe(true);
    expect(client.send({ type: "releaseControl" })).toBe(true);
    socket.control({ ...agent, generation: 2 });
    expect(client.send({ type: "text", text: "late input" })).toBe(false);
    expect(client.send({ type: "dialog", accept: false })).toBe(false);
    client.stop();
  });
});

describe("preview stream downloads", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("offers a download at a URL carrying the stream's ticket", () => {
    const onDownload = vi.fn();
    createPreviewStreamClient(
      {
        ...target,
        access: { ...target.access, query: { wsTicket: "ticket" }, credentials: false },
      },
      {
        onFrame: vi.fn(),
        onDownload,
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "download", id: "d1", fileName: "a b.csv", sizeBytes: 3 }),
    );
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({
      fileName: "a b.csv",
      sizeBytes: 3,
      url: "http://preview.test/api/preview-stream/download?threadId=thread&tabId=tab&id=d1&wsTicket=ticket",
    });
  });
});

describe("preview stream agent pointer", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports where the agent moves and clicks, ignoring malformed points", () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPointer,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "drag", x: 1, y: 2, sequence: 1 }),
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "click", x: 140, y: 50, sequence: 2 }),
    );
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({
      phase: "click",
      x: 140,
      y: 50,
      sequence: 2,
    });
  });
});
