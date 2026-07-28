import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

/**
 * Composer intake rules shared by drag, paste, and the file picker.
 *
 * Kept free of DOM object creation so the accept/reject decisions can be
 * tested directly; the caller turns accepted files into draft attachments.
 */

export function isComposerImageMimeType(mimeType: string): boolean {
  return mimeType.trim().toLowerCase().startsWith("image/");
}

/**
 * Browsers leave `File.type` empty for extensions they don't recognise. The
 * contract requires a non-empty mime, and the server derives the stored file
 * extension from it, so the generic binary type is the honest fallback.
 */
export function resolveComposerAttachmentMimeType(file: File): string {
  const mimeType = file.type.trim();
  return mimeType.length > 0 ? mimeType : "application/octet-stream";
}

export function formatComposerAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(0)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface PlannedComposerAttachment {
  file: File;
  type: "image" | "file";
  mimeType: string;
}

export interface ComposerAttachmentIntakePlan {
  accepted: PlannedComposerAttachment[];
  /**
   * Last rejection reason, surfaced as the thread error the way the
   * image-only intake always has. One line is enough: a drop is usually
   * rejected for one reason.
   */
  error: string | null;
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))}MB`;

/**
 * Decides which dropped/pasted/picked files the composer takes.
 *
 * `allowNonImageFiles` is the Hermes gate: every other provider rejects
 * non-images exactly as before, so their intake surface is unchanged.
 */
export function planComposerAttachmentIntake(input: {
  files: ReadonlyArray<File>;
  existingCount: number;
  allowNonImageFiles: boolean;
}): ComposerAttachmentIntakePlan {
  const accepted: PlannedComposerAttachment[] = [];
  let count = input.existingCount;
  let error: string | null = null;

  for (const file of input.files) {
    const mimeType = resolveComposerAttachmentMimeType(file);
    const isImage = isComposerImageMimeType(mimeType);
    if (!isImage && !input.allowNonImageFiles) {
      error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
      continue;
    }
    const maxBytes = isImage
      ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
    if (file.size > maxBytes) {
      error = `'${file.name}' exceeds the ${megabytes(maxBytes)} attachment limit.`;
      continue;
    }
    if (count >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = input.allowNonImageFiles
        ? `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`
        : `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
      break;
    }
    accepted.push({ file, type: isImage ? "image" : "file", mimeType });
    count += 1;
  }

  return { accepted, error };
}
