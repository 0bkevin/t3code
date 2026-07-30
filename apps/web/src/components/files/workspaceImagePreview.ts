export function workspaceImagePreviewUrl(assetUrl: string, revision: number): string {
  const separator = assetUrl.includes("?") ? "&" : "?";
  return `${assetUrl}${separator}t3-file-revision=${revision}`;
}
