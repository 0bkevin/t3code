import { describe, expect, it } from "vite-plus/test";

import { workspaceImagePreviewUrl } from "./workspaceImagePreview";

describe("workspaceImagePreviewUrl", () => {
  it("changes the image URL for every filesystem revision", () => {
    expect(workspaceImagePreviewUrl("https://example.test/image.png", 0)).toBe(
      "https://example.test/image.png?t3-file-revision=0",
    );
    expect(workspaceImagePreviewUrl("https://example.test/image.png", 2)).toBe(
      "https://example.test/image.png?t3-file-revision=2",
    );
  });

  it("preserves existing query parameters", () => {
    expect(workspaceImagePreviewUrl("https://example.test/image.png?token=abc", 1)).toBe(
      "https://example.test/image.png?token=abc&t3-file-revision=1",
    );
  });
});
