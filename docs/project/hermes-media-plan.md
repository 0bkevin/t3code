# Hermes Media Support — Implementation Plan

Send images, videos, PDFs, and arbitrary files to the Hermes agent through T3
Code, and render media the agent sends back natively in the web UI. Guiding
principle: the smallest coherent design — reuse the existing attachment store,
asset-token pipeline, and message-attachment plumbing built for images. No new
storage system, no transcoding, no thumbnails, no chunking, no CDN.

Decisions below were settled in a product interview (2026-07-27); they are
recorded as **Decision:** lines rather than open questions.

## What already exists (verified)

- **Inbound image pipeline, end to end:** composer paste/drag →
  `readFileAsDataUrl` base64 → `thread.turn.start` `message.attachments` →
  `Normalizer.ts` decodes/validates and writes to
  `<stateDir>/attachments/<id><ext>` (`attachmentStore.ts`) → message rows
  persist `attachments_json` → signed 1-hour asset URLs
  (`assets/AssetAccess.ts`, `/api/assets/<token>/<name>`) → web resolves via
  `useAssetUrls`. `ChatView.tsx` already resolves attachment ids for **all**
  message roles.
- **Hermes gateway protocol v3** (`packages/contracts/src/hermesGateway.ts`):
  strict lockstep version check in `HermesGatewayBroker`; turn input is
  text-only; `home.deliver` (text ≤ 120k) with durable-write-then-ack;
  capabilities currently pin `attachments: false`.
- **`HermesAdapter.sendTurn` hard-rejects attachments** (line ~729).
- **Rendering:** user rows show image grids from `message.attachments`;
  assistant rows render markdown only. No `<video>` anywhere; PDFs only in
  workspace file previews.

## Decisions

- **Ship order:** outbound (Hermes → user) first, inbound second.
- **Transport:** inline base64 on WS frames, no chunking. 25MB per
  `media.deliver` frame outbound; 10MB/file, 25MB/turn total inbound. Clear
  errors when exceeded.
- **Native rendering v1:** images (inline + zoom), video (`<video controls>`),
  PDF (card → new tab, browser-native viewer). Everything else — including
  audio — gets a download card.
- **Provider reach:** non-image attachments are Hermes-only in the composer.
  The `ChatAttachment` contract gains the generic variant for everyone, but
  other providers keep today's image-only intake — zero regression surface.
- **Protocol versioning: bump to v4, strict lockstep.** Matches the v2→v3
  precedent. Every deployed plugin must upgrade to reconnect; the T3-side and
  plugin-side changes land together. The `attachments` capability literal
  flips to `true` as part of v4 rather than becoming a negotiation flag.
- **Media lands as a standalone assistant message** (optional caption in the
  same row), never merged into the streaming text message — keeps the
  delta/replace fold untouched and behaves identically mid-turn, end-of-turn,
  and proactively.
- **Mime policy:** no allowlist beyond size (agent-owned trust domain), with
  one guard: assistant-sent SVGs render as download cards, never inline
  `<img>` (same-origin-served SVG can execute script).
- **Delivery scope:** `turnId` optional. Turnless media resolves to the Home
  thread exactly like `home.deliver` (server re-resolves via
  `getOrCreateHomeThread`, refuses arbitrary thread ids), accepted from both
  gateway- and delivery-role connections.
- **Captions:** `media.deliver` carries an optional `caption`, rendered as
  small text under the media in the same message row.
- **Home-thread provenance:** media deliveries carry the same `kind`/`label`
  provenance as `home.deliver`, so a cron-produced chart gets the
  NotificationHeader (source · relative time · rule) and marks the sidebar row
  New via `latestNotification`.
- **Send UX (inbound phase):** extend drag/paste to all file types on Hermes
  threads + a paperclip picker button in the composer footer. Non-image files
  show as name+size chips in the pending strip.

## Design

### Contracts (`packages/contracts`)

1. `orchestration.ts`: add `ChatFileAttachment { type: "file", id, name,
mimeType, sizeBytes }` + `UploadChatFileAttachment { …, dataUrl }`;
   `ChatAttachment` becomes the two-variant union. Rendering kind
   (image/video/pdf/generic) is derived from `mimeType` client-side, never
   encoded in the schema. Limits: `PROVIDER_SEND_TURN_MAX_FILE_BYTES = 10MB`,
   reuse `PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8`.
2. `hermesGateway.ts`: `HERMES_GATEWAY_PROTOCOL_VERSION = 4`. Add:
   - `turn.start` / `turn.steer`: optional
     `attachments: Array<{ name, mimeType, sizeBytes, data }>` (base64).
   - Plugin→T3 `media.deliver { deliveryId, threadId?, turnId?, kind, label,
name, mimeType, sizeBytes, caption?, data }` with
     `HERMES_MEDIA_DELIVER_MAX_BYTES = 25MB` (schema-level max length on
     `data`, re-checked after decode).
   - T3→plugin `media.deliver.ack { deliveryId }` — sent only after durable
     write, mirroring `home.deliver`'s pessimistic ack.
   - Capabilities `attachments: Schema.Literal(true)`.

### Server

3. `attachmentStore.ts`: generalize `attachmentRelativePath` for
   `type: "file"` (small mime→ext map, `.bin` fallback); extend the filename
   extension allowlist. Id scheme, traversal guards, and asset serving are
   unchanged.
4. `media.deliver` handling (alongside `deliverHomeNotification` in
   `hermesGatewayHttp.ts` for turnless/delivery-role, in `HermesAdapter`'s
   frame handler for turn-scoped): decode, size-check, write via
   `createAttachmentId(threadId)`, then dispatch a new internal command
   `thread.message.media` — appends an assistant message with
   `attachments: [...]`, optional caption text, optional `turnId`, and
   notification provenance; deduped on `deliveryId` in the projection the same
   way home deliveries are. `ThreadMessageSentPayload` already carries
   optional attachments and the projection already persists
   `attachments_json`, so the decider/projector delta is small.
5. `HermesAdapter.sendTurn`/steer: replace the rejection with read-from-
   `attachmentsDir` + base64-encode + include on the frame (the
   `ClaudeAdapter.buildUserMessageEffect` pattern), enforcing the 25MB/turn
   total.

### Web

6. New `apps/web/src/components/chat/MessageAttachments.tsx`, keyed off
   `mimeType`:
   - `image/*` (except `image/svg+xml`) → existing grid + `ExpandedImageDialog`
     (extracted from `UserTimelineRow`).
   - `video/*` → `<video controls preload="metadata">`.
   - `application/pdf` → card opening the signed URL in a new tab.
   - everything else (incl. SVG, audio) → download card (icon, name, size,
     `download` link).
7. `MessagesTimeline.tsx`: `AssistantTimelineRow` renders the component above
   the markdown body (caption below media); `UserTimelineRow` swaps its inline
   grid for the same component. Media deliveries reuse the existing
   `NotificationHeader` path via their provenance fields.
8. Composer (inbound phase): accept all file types on Hermes threads in the
   drag/paste handler; add the paperclip button; chips for non-image files;
   client-side size/count enforcement mirroring the contracts.
9. Known v1 rough edge (documented in code): asset URLs expire after 1 hour;
   long-lived open threads may need refetch-on-error for `<img>`/`<video>`.

### Plugin (NousResearch/hermes-agent — separate repo, lands with v4)

- Bump protocol to 4; advertise `attachments: true`.
- Accept `attachments` on `turn.start`/`turn.steer` → temp files → hand to
  Hermes.
- Emit `media.deliver` with a durable queue purged on ack, exactly like its
  `home.deliver` queue.

## Phases

**Phase 1 — Outbound (protocol v4 + rendering):** contracts (v4 frames,
`ChatFileAttachment`), attachment store generalization, `media.deliver`
handler + `thread.message.media` command/projection, `MessageAttachments`
with all four render kinds, plugin-side emit. Ships when a Hermes chart/image
renders in the thread and a cron-produced file lands in Home with a header.

**Phase 2 — Inbound:** composer intake (drag/paste + paperclip, chips),
Normalizer generalization, `HermesAdapter` attachment forwarding, plugin-side
accept.

**Phase 3 — Polish/QA:** token-expiry refetch-on-error, size formatting, dark
mode on cards, proactive-media edge cases, mobile timeline rendering pass.

## Out of scope

No transcoding/thumbnails/resizing; no chunked or resumable transfer (hard
caps instead — chunking is the escape hatch if >25MB ever matters); no CDN or
external storage; no GC of `attachmentsDir` (pre-existing gap, unchanged); no
inline PDF iframe; no native audio player (download card); no non-image
attachments for other providers' composers; no markdown `![img]` asset
rewriting in `ChatMarkdown`.
