import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { useServerRestartReconnect } from "./useServerRestartReconnect";

/**
 * Reconnects environments through an expected server restart. Mounted here
 * because a restart outlives the view it was triggered from — the update
 * action appears both in the chat composer's skew banner and in
 * Settings → Connections.
 */
export function ServerRestartReconnectHost() {
  useServerRestartReconnect();
  return null;
}

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <ServerRestartReconnectHost />
      <RouterProvider router={router} />
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
    </AppAtomRegistryProvider>
  );
}
