import { assert, it } from "@effect/vitest";

import { shouldPrepareLegacyImportHandoff } from "./Orchestrator.ts";

it("reissues imported context until the provider thread is materialized", () => {
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasNativeThreadRef: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasNativeThreadRef: true,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: undefined,
      hasNativeThreadRef: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasNativeThreadRef: false,
      legacyImportItemCount: 0,
    }),
  );
});
