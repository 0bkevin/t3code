import { describe, expect, it } from "vite-plus/test";

import { deriveAuthClientMetadata, resolveSessionCookieName } from "./utils.ts";

describe("resolveSessionCookieName", () => {
  it("preserves the legacy cookie name for the canonical web port", () => {
    expect(resolveSessionCookieName({ mode: "web", port: 3773 })).toBe("t3_session");
  });

  it("isolates web sessions on non-default ports", () => {
    expect(resolveSessionCookieName({ mode: "web", port: 7446 })).toBe("t3_session_7446");
    expect(resolveSessionCookieName({ mode: "web", port: 7447 })).toBe("t3_session_7447");
  });

  it("keeps desktop sessions isolated by port", () => {
    expect(resolveSessionCookieName({ mode: "desktop", port: 3773 })).toBe("t3_session_3773");
    expect(resolveSessionCookieName({ mode: "desktop", port: 7446 })).toBe("t3_session_7446");
  });
});

describe("deriveAuthClientMetadata", () => {
  it("labels Electron user agents as Electron instead of Chrome", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) t3code/0.0.15 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        source: {
          remoteAddress: "::ffff:127.0.0.1",
        },
      } as never,
    });

    expect(metadata).toMatchObject({
      browser: "Electron",
      deviceType: "desktop",
      ipAddress: "127.0.0.1",
      os: "macOS",
    });
  });

  it("applies client-presented display identity without replacing transport metadata", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        source: {
          remoteAddress: "::ffff:192.168.213.72",
        },
      } as never,
      presented: {
        label: "T3 Code Mobile",
        deviceType: "mobile",
        os: "iOS",
      },
    });

    expect(metadata).toMatchObject({
      label: "T3 Code Mobile",
      browser: "Electron",
      deviceType: "mobile",
      ipAddress: "192.168.213.72",
      os: "iOS",
    });
    expect(metadata.userAgent).toContain("Electron/36.3.2");
  });
});
