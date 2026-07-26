import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { AppRoot, ServerRestartReconnectHost } from "./AppRoot";

describe("AppRoot", () => {
  it("shares the application atom registry with routed UI and renderer-wide desktop hosts", () => {
    const root = AppRoot({ router: {} as AppRouter });

    expect(root.type).toBe(AppAtomRegistryProvider);
    const children = Children.toArray(
      (root as ReactElement<{ readonly children: ReactNode }>).props.children,
    );
    expect(children).toHaveLength(4);
    // The restart-reconnect host is inside the registry provider (it reads
    // environment atoms) and outside the router, because a server restart
    // outlives the route the update was triggered from.
    expect(isValidElement(children[0]) && children[0].type).toBe(ServerRestartReconnectHost);
    expect(isValidElement(children[1]) && children[1].type).toBe(RouterProvider);
    expect(isValidElement(children[2]) && children[2].type).toBe(PreviewAutomationHosts);
    expect(isValidElement(children[3]) && children[3].type).toBe(ElectronBrowserHost);
  });
});
