import {
  Outlet,
  createRootRoute,
  type ErrorComponentProps,
  useLocation,
} from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";

import { APP_BASE_NAME, APP_DISPLAY_NAME, APP_STAGE_LABEL } from "../branding";
import { resolveServerBackedAppDisplayName } from "../branding.logic";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPaletteShell } from "../components/CommandPaletteShell";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { STARTUP_OPTIONAL_UI_DELAY_MS, useAfterFirstPaint } from "../hooks/useAfterFirstPaint";
import { useClientSettings } from "../hooks/useSettings";
import { syncBrowserChromeTheme } from "../hooks/useTheme";
import { configureClientTracing } from "../observability/clientTracing";
import { markStartupMilestone } from "../startupPerformance";
import { resolveInitialServerAuthGateState } from "../environments/primary";
import { hasHostedPairingRequest, isHostedStaticApp } from "../hostedPairing";
import { useAtomValue } from "@effect/atom-react";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import { primaryServerConfigAtom } from "../state/server";
import {
  setActiveEnvironmentId,
  useActiveEnvironmentId,
  useAllEnvironmentShellsBootstrapped,
} from "../state/entities";

const AppOverlays = lazy(() => import("../components/AppOverlays"));
const EventRouter = lazy(() => import("./-EventRouter"));
const ProviderUpdateLaunchNotification = lazy(() =>
  import("../components/ProviderUpdateLaunchNotification").then((module) => ({
    default: module.ProviderUpdateLaunchNotification,
  })),
);

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    const url = new URL(window.location.href);
    const authGateState =
      location.pathname === "/pair" && hasHostedPairingRequest(url)
        ? ({ status: "hosted-pairing" } as const)
        : isHostedStaticApp(url)
          ? ({ status: "hosted-static" } as const)
          : await resolveInitialServerAuthGateState();
    markStartupMilestone("auth.gate.resolved");
    return { authGateState };
  },
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { authGateState } = Route.useRouteContext();
  const primaryEnvironmentAuthenticated = authGateState.status === "authenticated";
  const loadEventRouter = useAfterFirstPaint();
  const loadOptionalUi = useAfterFirstPaint(STARTUP_OPTIONAL_UI_DELAY_MS);

  useEffect(() => {
    markStartupMilestone("react.usable");
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      syncBrowserChromeTheme();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [pathname]);

  if (pathname === "/pair" || pathname === "/connect" || pathname.startsWith("/connect/")) {
    return (
      <>
        <DocumentTitleSync />
        <Outlet />
      </>
    );
  }

  if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
    return (
      <>
        <DocumentTitleSync />
        <Outlet />
      </>
    );
  }

  const appShell = (
    <CommandPaletteShell>
      <AppSidebarLayout>
        <Outlet />
      </AppSidebarLayout>
    </CommandPaletteShell>
  );

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <DocumentTitleSync />
        <GlassAppearanceSync />
        {primaryEnvironmentAuthenticated ? <AuthenticatedTracingBootstrap /> : null}
        {primaryEnvironmentAuthenticated ? <StartupConnectionMilestones /> : null}
        {loadOptionalUi ? (
          <Suspense fallback={null}>
            <AppOverlays />
            {primaryEnvironmentAuthenticated ? <ProviderUpdateLaunchNotification /> : null}
          </Suspense>
        ) : null}
        <HostedStaticEnvironmentBootstrap />
        {primaryEnvironmentAuthenticated && loadEventRouter ? (
          <Suspense fallback={null}>
            <EventRouter />
          </Suspense>
        ) : null}
        {appShell}
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function GlassAppearanceSync() {
  const glassOpacity = useClientSettings((settings) => settings.glassOpacity);

  useEffect(() => {
    document.documentElement.style.setProperty("--glass-opacity", `${glassOpacity}%`);
  }, [glassOpacity]);

  return null;
}

function DocumentTitleSync() {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;
  const title = resolveServerBackedAppDisplayName({
    baseName: APP_BASE_NAME,
    fallbackDisplayName: APP_DISPLAY_NAME,
    fallbackStageLabel: APP_STAGE_LABEL,
    primaryServerVersion,
  });

  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(() => {
    if (primaryServerVersion !== null) {
      markStartupMilestone("config.received");
    }
  }, [primaryServerVersion]);

  return null;
}

function StartupConnectionMilestones() {
  const primaryEnvironment = usePrimaryEnvironment();
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();

  useEffect(() => {
    if (primaryEnvironment?.connection.phase === "connected") {
      markStartupMilestone("ws.open");
    }
  }, [primaryEnvironment?.connection.phase]);

  useEffect(() => {
    if (shellsBootstrapped) {
      markStartupMilestone("shell.live");
    }
  }, [shellsBootstrapped]);

  return null;
}

function HostedStaticEnvironmentBootstrap() {
  const { environments } = useEnvironments();
  const activeEnvironmentId = useActiveEnvironmentId();

  useEffect(() => {
    if (
      environments.some(
        (environment) => environment.entry.target._tag === "PrimaryConnectionTarget",
      )
    ) {
      return;
    }

    if (activeEnvironmentId) {
      return;
    }

    const firstSavedEnvironment = environments[0];
    if (!firstSavedEnvironment) {
      return;
    }

    setActiveEnvironmentId(firstSavedEnvironment.environmentId);
  }, [activeEnvironmentId, environments]);

  return null;
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

function AuthenticatedTracingBootstrap() {
  useEffect(() => {
    void configureClientTracing();
  }, []);

  return null;
}
