import { DownloadIcon, FileIcon, FileTextIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import type { ChatAttachment } from "../../types";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";

/**
 * Which native rendering an attachment gets, derived from its mime alone —
 * the contract deliberately does not encode a rendering kind, so adding a
 * renderable type is a change here, never a schema migration.
 *
 * SVG is intentionally NOT inline-image: the asset route serves same-origin,
 * and an inline `<img>`-adjacent SVG is one `foreignObject` away from script
 * execution. Hermes is the user's own agent, but "my agent got confused" is
 * exactly the failure mode a download card contains and inline render does
 * not.
 */
export function resolveAttachmentRenderKind(
  attachment: Pick<ChatAttachment, "type" | "mimeType">,
): "image" | "video" | "pdf" | "file" {
  const mime = attachment.mimeType.trim().toLowerCase();
  if (mime === "image/svg+xml") return "file";
  if (attachment.type === "image" || mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return "file";
}

function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(0)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentCard({
  attachment,
  icon,
  actionLabel,
}: {
  attachment: ChatAttachment;
  icon: React.ReactNode;
  actionLabel: string;
}) {
  const card = (
    <span className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border/80 bg-background/70 px-3 py-2">
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground/90">{attachment.name}</span>
        <span className="block text-xs text-muted-foreground">
          {formatAttachmentSize(attachment.sizeBytes)}
        </span>
      </span>
      {attachment.previewUrl ? (
        <DownloadIcon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden />
      ) : null}
    </span>
  );
  if (!attachment.previewUrl) {
    // The signed URL has not resolved yet (or the asset is gone); an inert
    // card beats a dead link.
    return <span className="block max-w-[420px]">{card}</span>;
  }
  return (
    <a
      href={attachment.previewUrl}
      // PDFs open in the browser's own viewer; everything else downloads.
      {...(actionLabel === "Open"
        ? { target: "_blank", rel: "noreferrer" }
        : { download: attachment.name })}
      aria-label={`${actionLabel} ${attachment.name}`}
      className="block max-w-[420px] transition-colors hover:[&>span]:bg-accent/40"
    >
      {card}
    </a>
  );
}

/**
 * Renders a message's attachments natively: images inline with the zoom
 * dialog, videos with the browser's player, PDFs as open-in-tab cards, and
 * everything else as download cards. Shared by user and assistant rows so
 * the two sides cannot drift.
 */
export const MessageAttachments = memo(function MessageAttachments({
  attachments,
  onImageExpand,
  className,
}: {
  attachments: ReadonlyArray<ChatAttachment>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  className?: string;
}) {
  if (attachments.length === 0) return null;

  const images = attachments.filter((a) => resolveAttachmentRenderKind(a) === "image");
  const rest = attachments.filter((a) => resolveAttachmentRenderKind(a) !== "image");

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      {images.length > 0 ? (
        <div className="grid max-w-[420px] grid-cols-2 gap-2">
          {images.map((image) => (
            <div
              key={image.id}
              className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
            >
              {image.previewUrl ? (
                <button
                  type="button"
                  className="h-full w-full cursor-zoom-in"
                  aria-label={`Preview ${image.name}`}
                  onClick={() => {
                    const preview = buildExpandedImagePreview(images, image.id);
                    if (!preview) return;
                    onImageExpand(preview);
                  }}
                >
                  <img
                    src={image.previewUrl}
                    alt={image.name}
                    className="block h-auto max-h-[220px] w-full object-cover"
                  />
                </button>
              ) : (
                <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                  {image.name}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {rest.map((attachment) => {
        const kind = resolveAttachmentRenderKind(attachment);
        if (kind === "video" && attachment.previewUrl) {
          return (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- agent-produced media carries no track
            <video
              key={attachment.id}
              controls
              preload="metadata"
              src={attachment.previewUrl}
              className="max-h-[360px] max-w-[560px] rounded-lg border border-border/80 bg-black/40"
            />
          );
        }
        if (kind === "pdf") {
          return (
            <AttachmentCard
              key={attachment.id}
              attachment={attachment}
              actionLabel="Open"
              icon={<FileTextIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />}
            />
          );
        }
        return (
          <AttachmentCard
            key={attachment.id}
            attachment={attachment}
            actionLabel="Download"
            icon={<FileIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />}
          />
        );
      })}
    </div>
  );
});
