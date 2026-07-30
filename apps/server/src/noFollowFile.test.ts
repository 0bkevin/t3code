import { describe, expect, it } from "@effect/vitest";

import { canonicalPathsMatch } from "./noFollowFile.ts";

describe("canonicalPathsMatch", () => {
  it("accepts canonical Windows paths whose casing differs", () => {
    expect(
      canonicalPathsMatch(
        String.raw`C:\Users\Example\capture.png`,
        String.raw`C:\Users\example\CAPTURE.png`,
        "win32",
      ),
    ).toBe(true);
  });

  it("keeps canonical path comparison case-sensitive on other platforms", () => {
    expect(
      canonicalPathsMatch("/Users/Example/capture.png", "/users/example/capture.png", "darwin"),
    ).toBe(false);
  });

  it("rejects Windows paths that differ by more than casing", () => {
    expect(
      canonicalPathsMatch(
        String.raw`C:\Users\Example\capture.png`,
        String.raw`C:\Users\Example\outside.png`,
        "win32",
      ),
    ).toBe(false);
  });
});
