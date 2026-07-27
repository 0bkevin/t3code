import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OrchestrationThreadShell } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";

const EMPTY_CLOSED_TASK_TABS: ReadonlyArray<OrchestrationThreadShell> = Object.freeze([]);
const EMPTY_CLOSED_TASK_TABS_ATOM = Atom.make(AsyncResult.success(EMPTY_CLOSED_TASK_TABS)).pipe(
  Atom.withLabel("web:closed-task-tabs:empty"),
);

function closedTaskTabsAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.closedTaskTabs({
    environmentId,
    input: {},
  });
}

export function refreshClosedTaskTabsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(closedTaskTabsAtom(environmentId));
}

export function useClosedTaskTabs(
  environmentId: EnvironmentId | null,
): ReadonlyArray<OrchestrationThreadShell> {
  const result = useAtomValue(
    environmentId === null ? EMPTY_CLOSED_TASK_TABS_ATOM : closedTaskTabsAtom(environmentId),
  );
  return Option.getOrElse(AsyncResult.value(result), () => EMPTY_CLOSED_TASK_TABS);
}
