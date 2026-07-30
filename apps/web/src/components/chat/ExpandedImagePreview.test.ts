import { describe, expect, it } from "vite-plus/test";

import { buildExpandedImagePreview } from "./ExpandedImagePreview";

describe("buildExpandedImagePreview", () => {
  it("opens the selected image at its index in the available gallery", () => {
    expect(
      buildExpandedImagePreview(
        [
          { id: "first", name: "first.png", previewUrl: "https://example.test/first.png" },
          { id: "missing", name: "missing.png" },
          { id: "second", name: "second.png", previewUrl: "https://example.test/second.png" },
        ],
        "second",
      ),
    ).toEqual({
      images: [
        { src: "https://example.test/first.png", name: "first.png" },
        { src: "https://example.test/second.png", name: "second.png" },
      ],
      index: 1,
    });
  });
});
