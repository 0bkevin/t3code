import type { HermesGatewayConnectionState, ProviderDriverKind } from "@t3tools/contracts";

export type WizardNavigation =
  | { readonly kind: "navigate"; readonly step: number }
  | { readonly kind: "blocked"; readonly step: number; readonly error: string };

const IDENTITY_STEP = 1;
const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export const ADD_PROVIDER_WIZARD_STEPS = ["Driver", "Identity", "Config"] as const;

/**
 * Hermes thread bindings outlive a removed gateway, so a new gateway must
 * never derive its routing identity from a reusable display name. The UUID is
 * generated once by the dialog and remains stable across enrollment retries.
 */
export function createHermesProviderInstanceId(label: string, randomUuid: () => string) {
  const suffix = randomUuid()
    .replace(/[^a-zA-Z0-9]/gu, "")
    .toLowerCase();
  if (suffix.length === 0) {
    throw new Error("Could not generate a Hermes instance ID.");
  }
  const labelSlug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 44);
  const shortSuffix = suffix.slice(0, 12);
  return labelSlug ? `hermes-${labelSlug}-${shortSuffix}` : `hermes-${shortSuffix}`;
}

/**
 * Command that installs the gateway plugin into the Hermes profile.
 *
 * Installation is a manual step performed on the Hermes host — T3 has no
 * remote access to it — so the dialog documents the command rather than
 * implying anything happens automatically. The script symlinks this repository
 * checkout into `~/.hermes/plugins` and enables the plugin.
 */
export const HERMES_PLUGIN_INSTALL_COMMAND = "./integrations/hermes-t3-gateway/install.sh" as const;

/**
 * Activates the pairing. The gateway only constructs the platform adapter at
 * startup, so it keeps reporting offline until it is restarted.
 */
export const HERMES_GATEWAY_RESTART_COMMAND = "hermes gateway restart" as const;

export function isHermesInstanceRemovedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "instance-removed"
  );
}

/**
 * Drop an instance the dialog itself just wrote, without clobbering anything
 * that changed underneath it.
 *
 * Used to roll back the settings write when Hermes enrollment fails. The
 * server is authoritative between the write and the rollback, so this reads
 * the *latest* map rather than restoring a captured pre-write snapshot — that
 * would silently revert instances added by another client in between. If the
 * id is already gone, or has been replaced by a different config object, the
 * write is not ours to undo and `null` signals "no rollback needed".
 */
export function rollbackProviderInstances<T>(input: {
  readonly latest: Readonly<Record<string, T>>;
  readonly instanceId: string;
  readonly written: T;
}): Record<string, T> | null {
  const current = input.latest[input.instanceId];
  if (current === undefined) return null;
  if (current !== input.written) return null;
  const next = { ...input.latest };
  delete next[input.instanceId];
  return next;
}

export function isOwnedHermesEnrollmentRetry(input: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: string;
  readonly createdHermesInstanceId: string | null;
}): boolean {
  return (
    input.driver === "hermes" &&
    input.createdHermesInstanceId !== null &&
    input.createdHermesInstanceId === input.instanceId
  );
}

/**
 * Presentation state of the post-enrollment "waiting for Hermes" panel.
 *
 * `waiting` is the expected steady state immediately after the command is
 * generated — the user still has to paste it and restart the gateway — so it
 * is deliberately not modelled as an error. `expired` and `blocked` are the
 * two states that need a fresh command, and `connected` is terminal success.
 */
export type HermesWaitingPhase = "waiting" | "connected" | "blocked" | "expired";

export interface HermesWaitingState {
  readonly phase: HermesWaitingPhase;
  readonly statusLabelState: HermesGatewayConnectionState;
  /** True while T3 legitimately has nothing to report yet. */
  readonly isPending: boolean;
  /** True when the only way forward is minting a replacement command. */
  readonly needsNewCommand: boolean;
}

/**
 * Resolve what the waiting panel should show.
 *
 * Connection wins over expiry: once the gateway has dialled in, the one-time
 * token has already been consumed and its expiry is irrelevant. `revoked` and
 * `upgrade-required` are surfaced ahead of the generic wait because neither
 * resolves by waiting longer.
 */
export function resolveHermesWaitingState(input: {
  readonly connectionState: HermesGatewayConnectionState | null;
  readonly isExpired: boolean;
}): HermesWaitingState {
  if (input.connectionState === "connected") {
    return {
      phase: "connected",
      statusLabelState: "connected",
      isPending: false,
      needsNewCommand: false,
    };
  }
  if (input.connectionState === "upgrade-required" || input.connectionState === "revoked") {
    return {
      phase: "blocked",
      statusLabelState: input.connectionState,
      isPending: false,
      needsNewCommand: input.connectionState === "revoked",
    };
  }
  if (input.isExpired) {
    return {
      phase: "expired",
      statusLabelState: input.connectionState ?? "offline",
      isPending: false,
      needsNewCommand: true,
    };
  }
  return {
    phase: "waiting",
    statusLabelState: input.connectionState ?? "offline",
    isPending: true,
    needsNewCommand: false,
  };
}

export function validateProviderInstanceIdForWizard(input: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: string;
  readonly existingIds: ReadonlySet<string>;
  readonly createdHermesInstanceId: string | null;
}): string | null {
  if (input.instanceId.length === 0) return "Instance ID is required.";
  if (input.instanceId.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(input.instanceId)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (
    input.existingIds.has(input.instanceId) &&
    !isOwnedHermesEnrollmentRetry({
      driver: input.driver,
      instanceId: input.instanceId,
      createdHermesInstanceId: input.createdHermesInstanceId,
    })
  ) {
    return `An instance named '${input.instanceId}' already exists.`;
  }
  return null;
}

/**
 * Resolve navigation within the add-provider wizard.
 *
 * Moving forward past Identity requires a valid instance id, whether the user
 * advances one step at a time or skips directly to Config from a step header.
 * A blocked skip lands on Identity so its existing inline validation is
 * visible. Backward navigation is always preserved.
 */
export function resolveWizardNavigation(
  currentStep: number,
  requestedStep: number,
  stepCount: number,
  validation: { readonly instanceIdError: string | null },
): WizardNavigation {
  const lastStep = Math.max(0, stepCount - 1);
  const targetStep = Math.max(0, Math.min(lastStep, requestedStep));
  const movesForwardPastIdentity = currentStep <= IDENTITY_STEP && targetStep > IDENTITY_STEP;

  if (movesForwardPastIdentity && validation.instanceIdError !== null) {
    return {
      kind: "blocked",
      step: Math.min(IDENTITY_STEP, lastStep),
      error: validation.instanceIdError,
    };
  }

  return { kind: "navigate", step: targetStep };
}
