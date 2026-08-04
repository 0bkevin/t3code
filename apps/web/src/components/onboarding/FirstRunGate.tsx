import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useClientSettings, useClientSettingsHydrated } from "../../hooks/useSettings";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../../state/entities";
import { primaryServerConfigAtom } from "../../state/server";

/**
 * Holds back the authenticated app tree until the first-run decision is known,
 * so a fresh install never flashes the main screen before the welcome wizard.
 * Nothing renders while pending — no shell, no EventRouter (whose welcome
 * payload would otherwise navigate into a thread), no dialogs.
 *
 * Decision order: a set `onboardingCompletedAt` resolves to the app as soon as
 * settings hydrate (the common case, no server round-trip). A `null` flag also
 * covers installs that predate the field, so it alone is not enough — the gate
 * waits for environment shells to bootstrap and inspects the workspace. A
 * timeout guards the pathological case where shells never bootstrap
 * (unreachable server): after it, the app renders as usual.
 */

const FIRST_RUN_DECISION_TIMEOUT_MS = 4_000;

type FirstRunDecision = "pending" | "app" | "wizard";

export function FirstRunGate({ children }: { readonly children: React.ReactNode }) {
  const navigate = useNavigate();
  const hydrated = useClientSettingsHydrated();
  const onboardingCompletedAt = useClientSettings((settings) => settings.onboardingCompletedAt);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  // Within a session settings stay hydrated, so remounts (e.g. returning from
  // the wizard) resolve synchronously instead of blanking a frame.
  const [decision, setDecision] = useState<FirstRunDecision>(() =>
    hydrated && onboardingCompletedAt !== null ? "app" : "pending",
  );

  // A workspace still counts as fresh when its only content is the server's
  // own cwd auto-bootstrap: web mode creates a project + thread from cwd at
  // startup (`autoBootstrapProjectFromCwd` defaults on there), so "no
  // projects at all" would mean `npx t3` users never see the wizard. Any
  // other project, or more than one thread, is real user state.
  const serverCwd = serverConfig?.cwd ?? null;
  const workspaceFresh =
    projects.every((project) => serverCwd !== null && project.workspaceRoot === serverCwd) &&
    threads.length <= 1;

  useEffect(() => {
    if (decision !== "pending" || !hydrated) return;
    if (onboardingCompletedAt !== null) {
      setDecision("app");
      return;
    }
    if (!bootstrapped) return;
    setDecision(workspaceFresh ? "wizard" : "app");
  }, [bootstrapped, decision, hydrated, onboardingCompletedAt, workspaceFresh]);

  useEffect(() => {
    if (decision !== "pending") return;
    const timer = window.setTimeout(() => setDecision("app"), FIRST_RUN_DECISION_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [decision]);

  useEffect(() => {
    if (decision === "wizard") {
      void navigate({ to: "/welcome", replace: true });
    }
  }, [decision, navigate]);

  if (decision !== "app") {
    return null;
  }
  return children;
}
