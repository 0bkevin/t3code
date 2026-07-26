import { createFileRoute, redirect } from "@tanstack/react-router";

import { AgentPage } from "../components/agents/AgentPage";
import { resolveAgentRouteInstanceId } from "../components/agents/AgentPage.logic";

function AgentRouteView() {
  const instanceId = Route.useParams({
    select: (params) => resolveAgentRouteInstanceId(params),
  });

  if (instanceId === null) {
    return null;
  }

  return <AgentPage key={instanceId} instanceId={instanceId} />;
}

export const Route = createFileRoute("/agents/$instanceId")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: AgentRouteView,
});
