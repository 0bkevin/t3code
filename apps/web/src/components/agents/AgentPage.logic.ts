import type {
  ProviderInstanceConnection,
  ProviderInstanceDescription,
  ProviderInstanceId,
  ServerProviderSkill,
} from "@t3tools/contracts";

import { getProviderVersionLabel, type ProviderStatusKey } from "../settings/providerStatus";
import { searchProviderSkills } from "../../providerSkillSearch";

/**
 * Placeholder for any field the driver did not report.
 *
 * Every nested block on `ProviderInstanceDescription` is individually
 * nullable, and a plausible-looking blank ("—", an empty cell) reads as "this
 * agent has no host / no model" rather than "nobody told us". The page always
 * renders this string instead so an absent value is never mistaken for a
 * negative one.
 */
export const AGENT_FIELD_NOT_REPORTED = "Not reported";

export type AgentConnectionStatus = ProviderInstanceConnection["status"];

export type AgentStatusBadgeVariant = "success" | "warning" | "error" | "secondary";

/**
 * Badge treatment per provider-generic connection status, mirroring the
 * Hermes settings card (`HermesGatewayInstanceSection.tsx`) so the two
 * surfaces speak the same visual language for the same instance.
 */
const AGENT_STATUS_BADGE_VARIANT: Record<AgentConnectionStatus, AgentStatusBadgeVariant> = {
  ready: "success",
  connecting: "warning",
  offline: "secondary",
  error: "error",
  disabled: "secondary",
};

export function agentStatusBadgeVariant(status: AgentConnectionStatus): AgentStatusBadgeVariant {
  return AGENT_STATUS_BADGE_VARIANT[status];
}

export function agentStatusLabel(status: AgentConnectionStatus): string {
  switch (status) {
    case "ready":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "offline":
      return "Offline";
    case "error":
      return "Error";
    case "disabled":
      return "Disabled";
  }
}

/**
 * Which `PROVIDER_STATUS_STYLES` dot to paint for a connection status.
 *
 * `offline` maps to the warning dot rather than a neutral one on purpose: an
 * agent that has not dialled in is actionable (the user has to start or
 * re-pair it), not merely idle.
 */
export function agentStatusDotStyleKey(status: AgentConnectionStatus): ProviderStatusKey {
  switch (status) {
    case "ready":
      return "ready";
    case "connecting":
    case "offline":
      return "warning";
    case "error":
      return "error";
    case "disabled":
      return "disabled";
  }
}

export function agentStatusGuidance(status: AgentConnectionStatus): string {
  switch (status) {
    case "ready":
      return "This agent is connected and ready for a new thread.";
    case "connecting":
      return "This agent is completing its handshake with T3 Code.";
    case "offline":
      return "This agent has not dialled in. Start it on its own host, then refresh.";
    case "error":
      return "This agent reported a failure. Reconnect, or check its setup in provider settings.";
    case "disabled":
      return "This instance is disabled for new sessions. Enable it in provider settings.";
  }
}

/** Trimmed text, or the explicit not-reported placeholder for null/blank. */
export function formatAgentText(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : AGENT_FIELD_NOT_REPORTED;
}

/** `0` is a real reading, so only `null`/`undefined` degrade to the placeholder. */
export function formatAgentCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return AGENT_FIELD_NOT_REPORTED;
  return value.toLocaleString("en-US");
}

export function formatAgentContextWindow(value: number | null | undefined): string {
  if (value === null || value === undefined) return AGENT_FIELD_NOT_REPORTED;
  return `${value.toLocaleString("en-US")} tokens`;
}

export function formatAgentProtocolVersion(value: number | null | undefined): string {
  if (value === null || value === undefined) return AGENT_FIELD_NOT_REPORTED;
  return `v${value}`;
}

/** Reuses the settings version normalizer so `1.2.3` and `v1.2.3` render alike. */
export function formatAgentVersion(value: string | null | undefined): string {
  return getProviderVersionLabel(value) ?? AGENT_FIELD_NOT_REPORTED;
}

/**
 * Absolute local timestamp for a reported ISO instant.
 *
 * An unparseable value is echoed back verbatim rather than swallowed: the
 * driver said *something*, and showing it is more debuggable than pretending
 * nothing was reported.
 */
export function formatAgentTimestamp(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === "") {
    return AGENT_FIELD_NOT_REPORTED;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * Best human name for the page heading.
 *
 * Falls back to the routed instance id so the page still identifies itself
 * before the first describe lands (or when the instance is unknown).
 */
export function agentPageTitle(
  description: ProviderInstanceDescription | null,
  instanceId: ProviderInstanceId | string,
): string {
  const displayName = description?.identity.displayName.trim();
  return displayName ? displayName : String(instanceId);
}

/**
 * Skills to render for the current filter box contents.
 *
 * An empty query shows every reported skill, disabled ones included, because
 * "what does this agent have installed?" is the question the page answers.
 * A non-empty query delegates to the shared ranker, which by design only
 * scores enabled skills — the same ordering the composer's `/` menu uses.
 */
export function filterAgentSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
  query: string,
): ReadonlyArray<ServerProviderSkill> {
  if (query.trim() === "") return skills;
  return searchProviderSkills(skills, query);
}

export interface AgentCapabilityEntry {
  readonly key: string;
  readonly label: string;
  readonly enabled: boolean;
}

/**
 * Turn a driver's opaque capability record into stable, labelled rows.
 *
 * Sorted by key so the chip order does not churn between describes — the
 * record arrives as JSON and its property order is not guaranteed.
 */
export function agentCapabilityEntries(
  capabilities: Readonly<Record<string, boolean>> | null | undefined,
): ReadonlyArray<AgentCapabilityEntry> {
  if (!capabilities) return [];
  return Object.keys(capabilities)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => ({
      key,
      label: formatAgentCapabilityLabel(key),
      enabled: capabilities[key] === true,
    }));
}

/** `sessionResume` / `session_resume` / `session-resume` → `Session resume`. */
export function formatAgentCapabilityLabel(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  if (spaced === "") return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export type AgentSkillBodyEntry =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "loaded"; readonly markdown: string | null };

export type AgentSkillBodyCache = ReadonlyMap<string, AgentSkillBodyEntry>;

/**
 * Immutable insert into the per-page skill body cache.
 *
 * Bodies are fetched on expand and kept for the life of the page: re-opening
 * a row the user already looked at must not re-hit the driver.
 */
export function upsertAgentSkillBody(
  cache: AgentSkillBodyCache,
  skillName: string,
  entry: AgentSkillBodyEntry,
): AgentSkillBodyCache {
  const next = new Map(cache);
  next.set(skillName, entry);
  return next;
}

/** Only a settled entry counts as cached; a failed fetch is retried on re-expand. */
export function shouldFetchAgentSkillBody(cache: AgentSkillBodyCache, skillName: string): boolean {
  const entry = cache.get(skillName);
  if (entry === undefined) return true;
  return entry.status === "error";
}

/** Accordion toggle: expanding the open row collapses it. */
export function nextExpandedSkillName(current: string | null, skillName: string): string | null {
  return current === skillName ? null : skillName;
}

/**
 * Whether the "Reconnect" action can consult an authoritative gateway status
 * after re-probing.
 *
 * Only remote-gateway drivers have a connection to interrogate; a local-process
 * driver's probe result *is* its status, so asking for a gateway status would
 * fail with `instance-not-found` and surface a scary error for a no-op.
 */
export function supportsGatewayReconnect(driver: string | null | undefined): boolean {
  return driver === "hermes";
}

export type AgentPageAction = "describe" | "reconnect" | "newThread";

export function isAgentPageBusy(pendingAction: AgentPageAction | null): boolean {
  return pendingAction !== null;
}

/**
 * Coerce anything a failed command can squash to into display copy.
 *
 * `ProviderDescribeError` carries a `message`, plain `Error`s carry one, and
 * defects carry nothing useful — all three land on something renderable.
 */
export function messageFromAgentPageError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) return error;
  return "Could not read this agent's details.";
}

/** True when the failure is the server saying this instance is not configured. */
export function isAgentInstanceNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "instance-not-found"
  );
}

/**
 * Route param → branded instance id.
 *
 * Mirrors `resolveThreadRouteRef`: the router hands back raw strings, and the
 * brand is a compile-time tag the server re-validates anyway.
 */
export function resolveAgentRouteInstanceId(
  params: Partial<Record<"instanceId", string | undefined>>,
): ProviderInstanceId | null {
  const raw = params.instanceId?.trim();
  if (!raw) return null;
  return raw as ProviderInstanceId;
}
