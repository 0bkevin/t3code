import { createFileRoute } from "@tanstack/react-router";
import { WorktreesSettingsPanel } from "../components/settings/WorktreesSettingsPanel";

function SettingsWorktreesRoute() {
  return <WorktreesSettingsPanel />;
}

export const Route = createFileRoute("/settings/worktrees")({
  component: SettingsWorktreesRoute,
});
