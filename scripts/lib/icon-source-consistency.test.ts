// @effect-diagnostics nodeBuiltinImport:off - Tests compare static icon source files directly.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ICON_PROJECTS = ["dev", "nightly", "prod"].map((variant) =>
  join(REPOSITORY_ROOT, "assets", variant, "app-icon.icon"),
);

interface IconLayer {
  readonly name?: string;
  readonly position?: {
    readonly scale?: number;
    readonly "translation-in-points"?: ReadonlyArray<number>;
  };
}

interface IconProject {
  readonly groups?: ReadonlyArray<{ readonly layers?: ReadonlyArray<IconLayer> }>;
}

const readTextLayer = (projectPath: string) => {
  const project = JSON.parse(readFileSync(join(projectPath, "icon.json"), "utf8")) as IconProject;
  return project.groups
    ?.flatMap((group) => group.layers ?? [])
    .find((layer) => layer.name === "Text");
};

describe("icon sources", () => {
  it("keeps the visible T3 mark identical across all app variants", () => {
    const textSources = ICON_PROJECTS.map((projectPath) =>
      readFileSync(join(projectPath, "Assets", "text.svg"), "utf8"),
    );

    expect(new Set(textSources).size).toBe(1);
    for (const projectPath of ICON_PROJECTS) {
      expect(readTextLayer(projectPath)?.position).toEqual({
        scale: 8.5,
        "translation-in-points": [0, 0],
      });
    }
  });
});
