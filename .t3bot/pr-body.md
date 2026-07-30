## What Changed

- subscribe mounted workspace file previews to debounced filesystem change events from the connected T3 server
- re-read text previews when files change and perform a fresh read after remounting
- refresh open image previews with revisioned URLs and require revalidation for mutable workspace assets
- keep immutable attachment caching unchanged

This supersedes #4379, preserves Alex's original commits, rebases them onto current `main`, and adds the missing image-preview behavior.

## Why

Agent edits happen directly on disk, bypassing the file-write RPC that could invalidate client state. Text previews therefore kept cached query data, while image previews reused a mutable signed URL served with a one-hour cache lifetime. Watching the file on the connected server fixes both local and T3 connection flows without polling.

## Testing

- `vp test run apps/server/src/workspace/WorkspaceFileSystem.test.ts apps/server/src/assets/AssetAccess.test.ts apps/server/src/auth/RpcAuthorization.test.ts packages/client-runtime/src/state/runtime.test.ts apps/web/src/components/files/projectFilesQueryState.test.ts apps/web/src/components/files/workspaceImagePreview.test.ts`
- contracts, client-runtime, server, web, and mobile typechecks
- targeted lint and formatting checks

## Checklist

- [x] This PR is small and focused
- [x] I explained what changed and why
- [x] Screenshots are not applicable because this fixes stale data without changing the UI
- [x] Video is not applicable because no animation or interaction design changed
