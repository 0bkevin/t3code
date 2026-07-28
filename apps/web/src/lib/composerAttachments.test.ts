import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatComposerAttachmentSize,
  planComposerAttachmentIntake,
  resolveComposerAttachmentMimeType,
} from "./composerAttachments";

function makeFile(input: { name: string; mimeType: string; sizeBytes?: number }): File {
  const sizeBytes = input.sizeBytes ?? 8;
  return new File([new Uint8Array(sizeBytes)], input.name, { type: input.mimeType });
}

/** Avoids allocating a real 11MB buffer just to exercise the size guard. */
function makeOversizedFile(input: { name: string; mimeType: string; sizeBytes: number }): File {
  const file = makeFile({ name: input.name, mimeType: input.mimeType });
  Object.defineProperty(file, "size", { value: input.sizeBytes });
  return file;
}

describe("planComposerAttachmentIntake", () => {
  it("accepts any file type when non-image files are allowed (Hermes)", () => {
    const plan = planComposerAttachmentIntake({
      files: [
        makeFile({ name: "shot.png", mimeType: "image/png" }),
        makeFile({ name: "spec.pdf", mimeType: "application/pdf" }),
      ],
      existingCount: 0,
      allowNonImageFiles: true,
    });

    expect(plan.error).toBeNull();
    expect(plan.accepted.map((entry) => [entry.file.name, entry.type])).toEqual([
      ["shot.png", "image"],
      ["spec.pdf", "file"],
    ]);
  });

  it("rejects non-image files exactly as before when they are not allowed", () => {
    const plan = planComposerAttachmentIntake({
      files: [
        makeFile({ name: "spec.pdf", mimeType: "application/pdf" }),
        makeFile({ name: "shot.png", mimeType: "image/png" }),
      ],
      existingCount: 0,
      allowNonImageFiles: false,
    });

    expect(plan.accepted.map((entry) => entry.file.name)).toEqual(["shot.png"]);
    expect(plan.error).toBe(
      "Unsupported file type for 'spec.pdf'. Please attach image files only.",
    );
  });

  it("rejects a file over the 10MB per-file limit with feedback", () => {
    const plan = planComposerAttachmentIntake({
      files: [
        makeOversizedFile({
          name: "huge.pdf",
          mimeType: "application/pdf",
          sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
        }),
      ],
      existingCount: 0,
      allowNonImageFiles: true,
    });

    expect(plan.accepted).toEqual([]);
    expect(plan.error).toBe("'huge.pdf' exceeds the 10MB attachment limit.");
  });

  it("keeps the existing image size limit for images", () => {
    const plan = planComposerAttachmentIntake({
      files: [
        makeOversizedFile({
          name: "huge.png",
          mimeType: "image/png",
          sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
        }),
      ],
      existingCount: 0,
      allowNonImageFiles: false,
    });

    expect(plan.accepted).toEqual([]);
    expect(plan.error).toBe("'huge.png' exceeds the 10MB attachment limit.");
  });

  it("stops at the shared per-message attachment count", () => {
    const plan = planComposerAttachmentIntake({
      files: [
        makeFile({ name: "a.pdf", mimeType: "application/pdf" }),
        makeFile({ name: "b.pdf", mimeType: "application/pdf" }),
      ],
      existingCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
      allowNonImageFiles: true,
    });

    expect(plan.accepted.map((entry) => entry.file.name)).toEqual(["a.pdf"]);
    expect(plan.error).toBe(
      `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
    );
  });
});

describe("resolveComposerAttachmentMimeType", () => {
  it("falls back to the generic binary type for unrecognised extensions", () => {
    expect(resolveComposerAttachmentMimeType(makeFile({ name: "data.bin", mimeType: "" }))).toBe(
      "application/octet-stream",
    );
    expect(
      resolveComposerAttachmentMimeType(
        makeFile({ name: "spec.pdf", mimeType: "application/pdf" }),
      ),
    ).toBe("application/pdf");
  });
});

describe("formatComposerAttachmentSize", () => {
  it("scales the unit to the size", () => {
    expect(formatComposerAttachmentSize(512)).toBe("512 B");
    expect(formatComposerAttachmentSize(2048)).toBe("2 KB");
    expect(formatComposerAttachmentSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
