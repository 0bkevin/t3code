import { describe, expect, it } from "vite-plus/test";

import { resolveAttachmentRenderKind } from "./MessageAttachments";

describe("resolveAttachmentRenderKind", () => {
  it("renders raster images inline regardless of declared type variant", () => {
    expect(resolveAttachmentRenderKind({ type: "image", mimeType: "image/png" })).toBe("image");
    // A media delivery stores non-image/* under type "file", but an image
    // mime still renders inline.
    expect(resolveAttachmentRenderKind({ type: "file", mimeType: "image/jpeg" })).toBe("image");
  });

  it("routes SVG to a download card, never inline", () => {
    // Same-origin-served SVG can execute script; a confused agent must not
    // be able to put one in an <img>-adjacent render path.
    expect(resolveAttachmentRenderKind({ type: "file", mimeType: "image/svg+xml" })).toBe("file");
    expect(resolveAttachmentRenderKind({ type: "image", mimeType: "image/svg+xml" })).toBe("file");
  });

  it("gives video a player and PDF a card", () => {
    expect(resolveAttachmentRenderKind({ type: "file", mimeType: "video/mp4" })).toBe("video");
    expect(resolveAttachmentRenderKind({ type: "file", mimeType: "application/pdf" })).toBe("pdf");
  });

  it("defaults everything else to a download card", () => {
    expect(resolveAttachmentRenderKind({ type: "file", mimeType: "application/zip" })).toBe("file");
    expect(resolveAttachmentRenderKind({ type: "file", mimeType: "audio/mpeg" })).toBe("file");
    expect(resolveAttachmentRenderKind({ type: "file", mimeType: "text/plain" })).toBe("file");
  });
});
