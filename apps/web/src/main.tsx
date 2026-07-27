import React from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";
import { markStartupMilestone } from "./startupPerformance";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
markStartupMilestone("entry.loaded");

const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const CloudAuthRoot = React.lazy(() =>
  isElectron ? import("./cloud/ElectronCloudAuthRoot") : import("./cloud/CloudAuthRoot"),
);

const app = <AppRoot router={router} />;
const cloudAuthPublishableKey =
  clerkPublishableKey && hasCloudPublicConfig() ? clerkPublishableKey : null;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {cloudAuthPublishableKey ? (
      <React.Suspense fallback={null}>
        <CloudAuthRoot publishableKey={cloudAuthPublishableKey}>{app}</CloudAuthRoot>
      </React.Suspense>
    ) : (
      app
    )}
  </React.StrictMode>,
);
