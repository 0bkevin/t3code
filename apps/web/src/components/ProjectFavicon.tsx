import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import { FolderIcon } from "lucide-react";
import type { ComponentType } from "react";
import { useState } from "react";
import { useAssetUrl } from "../assets/assetUrls";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";

const loadedProjectFaviconSrcs = new Set<string>();

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
  /**
   * Driver kind when this project is an agent's, which makes it that agent's
   * mark instead of a directory favicon.
   *
   * An agent project has a real `workspaceRoot` — a synthetic directory the
   * server creates — so the favicon probe would otherwise run against it and
   * find nothing, or worse, find a stray icon left in that directory and
   * present an agent as a codebase. The identity that matters on this row is
   * which agent it is, not what happens to be on disk.
   */
  agentDriverKind?: ProviderDriverKind | undefined;
  /** Display name for the agent mark's accent/initials fallback. */
  agentDisplayName?: string | undefined;
}) {
  const src = useAssetUrl(input.environmentId, {
    _tag: "project-favicon",
    cwd: input.cwd,
  });
  const FallbackIcon = input.fallbackIcon ?? FolderIcon;

  if (input.agentDriverKind) {
    return (
      <ProviderInstanceIcon
        driverKind={input.agentDriverKind}
        displayName={input.agentDisplayName ?? input.agentDriverKind}
        {...(input.className ? { className: input.className } : {})}
        iconClassName="size-3.5 shrink-0"
      />
    );
  }

  if (!src || isProjectFaviconFallbackUrl(src)) {
    return <ProjectFaviconFallback className={input.className} icon={FallbackIcon} />;
  }

  return (
    <ProjectFaviconImage
      key={src}
      src={src}
      className={input.className}
      fallbackIcon={FallbackIcon}
    />
  );
}

function ProjectFaviconFallback({
  className,
  icon: Icon,
}: {
  readonly className?: string | undefined;
  readonly icon: ComponentType<{ className?: string }>;
}) {
  return <Icon className={`size-3.5 shrink-0 text-muted-foreground/50 ${className ?? ""}`} />;
}

function ProjectFaviconImage({
  src,
  className,
  fallbackIcon: FallbackIcon,
}: {
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
}) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading",
  );

  return (
    <>
      {status !== "loaded" ? (
        <ProjectFaviconFallback className={className} icon={FallbackIcon} />
      ) : null}
      <img
        src={src}
        alt=""
        className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loaded" ? "" : "hidden"} ${className ?? ""}`}
        onLoad={() => {
          loadedProjectFaviconSrcs.add(src);
          setStatus("loaded");
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}
