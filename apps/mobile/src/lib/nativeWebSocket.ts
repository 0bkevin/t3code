import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

// URLSession-backed WebSocket for iOS. React Native's built-in WebSocket uses
// SocketRocket on iOS, which never offers permessage-deflate, so server frames
// arrive uncompressed. URLSessionWebSocketTask offers the extension by default.
// Android needs none of this: React Native's OkHttp-backed WebSocket already
// negotiates permessage-deflate on its own.
//
// Only the surface Effect's `Socket.fromWebSocket` drives is implemented:
// addEventListener/removeEventListener for open/message/close/error (with
// `once` support), `readyState`, `send`, and `close`.

interface NativeEventSubscription {
  remove(): void;
}

interface T3WebSocketNativeModule {
  connect(id: number, url: string, protocols: string[]): void;
  sendText(id: number, text: string): void;
  sendBinary(id: number, base64: string): void;
  close(id: number, code: number, reason: string): void;
  addListener(
    eventName: "onOpen" | "onMessage" | "onClose" | "onError",
    listener: (payload: {
      id: number;
      data?: string;
      binary?: boolean;
      code?: number;
      reason?: string;
      message?: string;
    }) => void,
  ): NativeEventSubscription;
}

type NativeWebSocketEventType = "open" | "message" | "close" | "error";

interface ListenerEntry {
  readonly listener: (event: unknown) => void;
  readonly once: boolean;
}

const activeSockets = new Map<number, NativeWebSocket>();
let nextSocketId = 1;
let nativeListenersAttached = false;

function attachNativeListeners(module: T3WebSocketNativeModule) {
  if (nativeListenersAttached) {
    return;
  }
  nativeListenersAttached = true;
  module.addListener("onOpen", (payload) => {
    activeSockets.get(payload.id)?.handleOpen();
  });
  module.addListener("onMessage", (payload) => {
    activeSockets.get(payload.id)?.handleMessage(payload.data ?? "", payload.binary === true);
  });
  module.addListener("onClose", (payload) => {
    activeSockets.get(payload.id)?.handleClose(payload.code ?? 1006, payload.reason ?? "");
  });
  module.addListener("onError", (payload) => {
    activeSockets.get(payload.id)?.handleError(payload.message ?? "WebSocket error");
  });
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

class NativeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = NativeWebSocket.CONNECTING;

  private readonly id: number;
  private readonly module: T3WebSocketNativeModule;
  private readonly listeners = new Map<NativeWebSocketEventType, Set<ListenerEntry>>();

  constructor(module: T3WebSocketNativeModule, url: string, protocols?: string | Array<string>) {
    this.module = module;
    this.id = nextSocketId++;
    activeSockets.set(this.id, this);
    attachNativeListeners(module);
    const protocolList =
      typeof protocols === "string" ? [protocols] : protocols ? [...protocols] : [];
    module.connect(this.id, url, protocolList);
  }

  addEventListener(
    type: NativeWebSocketEventType,
    listener: (event: unknown) => void,
    options?: { once?: boolean },
  ): void {
    let entries = this.listeners.get(type);
    if (!entries) {
      entries = new Set();
      this.listeners.set(type, entries);
    }
    entries.add({ listener, once: options?.once === true });
  }

  removeEventListener(type: NativeWebSocketEventType, listener: (event: unknown) => void): void {
    const entries = this.listeners.get(type);
    if (!entries) {
      return;
    }
    for (const entry of entries) {
      if (entry.listener === listener) {
        entries.delete(entry);
      }
    }
  }

  send(data: string | Uint8Array | ArrayBuffer): void {
    if (typeof data === "string") {
      this.module.sendText(this.id, data);
      return;
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.module.sendBinary(this.id, bytesToBase64(bytes));
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === NativeWebSocket.CLOSING || this.readyState === NativeWebSocket.CLOSED) {
      return;
    }
    this.readyState = NativeWebSocket.CLOSING;
    this.module.close(this.id, code ?? 1000, reason ?? "");
  }

  handleOpen(): void {
    this.readyState = NativeWebSocket.OPEN;
    this.dispatch("open", { type: "open" });
  }

  handleMessage(data: string, binary: boolean): void {
    this.dispatch("message", {
      type: "message",
      data: binary ? base64ToUint8Array(data) : data,
    });
  }

  handleClose(code: number, reason: string): void {
    if (this.readyState === NativeWebSocket.CLOSED) {
      return;
    }
    this.readyState = NativeWebSocket.CLOSED;
    activeSockets.delete(this.id);
    this.dispatch("close", { type: "close", code, reason });
  }

  handleError(message: string): void {
    this.dispatch("error", new Error(message));
  }

  private dispatch(type: NativeWebSocketEventType, event: unknown): void {
    const entries = this.listeners.get(type);
    if (!entries) {
      return;
    }
    for (const entry of entries) {
      if (entry.once) {
        entries.delete(entry);
      }
      entry.listener(event);
    }
  }
}

/**
 * WebSocket constructor backed by URLSessionWebSocketTask, or `null` when
 * unavailable (Android, or an iOS binary predating the native module). Callers
 * fall back to the global WebSocket.
 */
export function nativeWebSocketConstructor():
  | ((url: string, protocols?: string | Array<string>) => globalThis.WebSocket)
  | null {
  if (Platform.OS !== "ios") {
    return null;
  }
  const module = requireOptionalNativeModule<T3WebSocketNativeModule>("T3WebSocket");
  if (!module) {
    return null;
  }
  return (url, protocols) =>
    new NativeWebSocket(module, url, protocols) as unknown as globalThis.WebSocket;
}
