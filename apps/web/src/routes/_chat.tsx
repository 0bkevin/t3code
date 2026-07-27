import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { STARTUP_OPTIONAL_UI_DELAY_MS, useAfterFirstPaint } from "../hooks/useAfterFirstPaint";

const ChatRouteGlobalShortcuts = lazy(() => import("./-ChatRouteGlobalShortcuts"));

function ChatRouteLayout() {
  const loadGlobalShortcuts = useAfterFirstPaint(STARTUP_OPTIONAL_UI_DELAY_MS);

  return (
    <>
      {loadGlobalShortcuts ? (
        <Suspense fallback={null}>
          <ChatRouteGlobalShortcuts />
        </Suspense>
      ) : null}
      <Outlet />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});
