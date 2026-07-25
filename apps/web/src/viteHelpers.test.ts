import { describe, expect, it } from "vite-plus/test";

import { resolveDevProxyTarget } from "./viteHelpers";

describe("resolveDevProxyTarget", () => {
  it("keeps the dev proxy on the private backend when the browser URL is public", () => {
    const browserWebSocketUrl = "wss://siva.example.test:7446";
    const privateProxyUrl = "http://localhost:13773";

    expect(resolveDevProxyTarget(privateProxyUrl)).toBe("http://localhost:13773/");
    expect(resolveDevProxyTarget(privateProxyUrl)).not.toBe(
      resolveDevProxyTarget(browserWebSocketUrl),
    );
  });

  it("converts websocket schemes and strips paths", () => {
    expect(resolveDevProxyTarget("ws://localhost:13773/api/hermes-gateway/ws?token=test")).toBe(
      "http://localhost:13773/",
    );
  });
});
