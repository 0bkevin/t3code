import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

const makeImageActivity = (item: Record<string, unknown>): OrchestrationThreadActivity => ({
  id: EventId.make("activity-image-1"),
  tone: "tool",
  kind: "tool.completed",
  summary: "Image view",
  payload: {
    itemType: "image_view",
    detail: "/tmp/generated.png",
    data: { completedAtMs: 1, item },
  },
  turnId: TurnId.make("turn-1"),
  createdAt: "2026-07-27T21:17:50.000Z",
});

const projectedItem = (activity: OrchestrationThreadActivity): Record<string, unknown> => {
  const payload = activity.payload as { data?: { item?: Record<string, unknown> } };
  return payload.data?.item ?? {};
};

describe("projectActivityPayload", () => {
  it("keeps the saved path for generated images while pruning the base64 result", () => {
    const projected = projectActivityPayload(
      makeImageActivity({
        id: "call-1",
        type: "imageGeneration",
        savedPath: "/Users/test/.codex/generated_images/thread/call.png",
        revisedPrompt: "a prompt",
        result: "iVBORw0KGgoAAAANSUhEUg",
        status: "completed",
      }),
    );

    const item = projectedItem(projected);
    expect(item.savedPath).toBe("/Users/test/.codex/generated_images/thread/call.png");
    expect(item.type).toBe("imageGeneration");
    // The generated image bytes are megabytes per activity and unread by clients.
    expect(item.result).toBeUndefined();
    expect(item.revisedPrompt).toBeUndefined();
  });

  it("keeps the viewed path for image view items", () => {
    const projected = projectActivityPayload(
      makeImageActivity({ id: "call-2", type: "imageView", path: "/tmp/screenshot.png" }),
    );

    const item = projectedItem(projected);
    expect(item.path).toBe("/tmp/screenshot.png");
    expect(item.type).toBe("imageView");
  });

  it("still prunes unrelated tool item payloads", () => {
    const projected = projectActivityPayload(
      makeImageActivity({ id: "call-3", type: "somethingElse", secret: "value" }),
    );

    expect(projectedItem(projected)).toEqual({});
  });
});
