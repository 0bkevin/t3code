import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import { ServerProviderSkill } from "./server.ts";
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. Once every producer
  // populates it (post-slice-4), routing flips to instance-id-only and the
  // legacy `provider` field is removed.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;

/**
 * Provider-generic agent description.
 *
 * Backs the Agent page. Deliberately not Hermes-shaped: every driver can
 * answer this from its existing `ServerProvider` snapshot, and drivers that
 * know more (Hermes, which can ask its plugin) override with richer data.
 *
 * Every block below the identity is nullable — a driver that cannot report
 * a block sends `null` and the page renders an explicit "not reported"
 * state rather than a plausible-looking blank.
 */
export const ProviderInstanceIdentity = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: TrimmedNonEmptyString,
  /** The driver's own version (e.g. Hermes agent version, Codex CLI version). */
  agentVersion: Schema.NullOr(TrimmedNonEmptyString),
  /** Bridge/plugin version where one exists (Hermes gateway plugin). Null otherwise. */
  pluginVersion: Schema.NullOr(TrimmedNonEmptyString),
  /** Wire protocol version where one exists. Null otherwise. */
  protocolVersion: Schema.NullOr(PositiveInt),
  /** Where the agent runs, when the driver knows (Hermes connector URL host). */
  host: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProviderInstanceIdentity = typeof ProviderInstanceIdentity.Type;

export const ProviderInstanceConnection = Schema.Struct({
  /**
   * Coarse, provider-generic connection state. Local-process drivers report
   * `ready`/`error`/`disabled` from their probe; remote drivers map their own
   * connection state onto this.
   */
  status: Schema.Literals(["ready", "connecting", "offline", "error", "disabled"]),
  detail: Schema.NullOr(TrimmedNonEmptyString),
  lastConnectedAt: Schema.NullOr(IsoDateTime),
  activeSessionCount: Schema.NullOr(NonNegativeInt),
  /** See `HermesGatewayInstanceStatus.connectionGeneration`. Null for local drivers. */
  connectionGeneration: Schema.NullOr(NonNegativeInt),
});
export type ProviderInstanceConnection = typeof ProviderInstanceConnection.Type;

export const ProviderInstanceModelInfo = Schema.Struct({
  id: Schema.NullOr(TrimmedNonEmptyString),
  displayName: Schema.NullOr(TrimmedNonEmptyString),
  /** The upstream model vendor behind this model, when the driver reports one. */
  vendor: Schema.NullOr(TrimmedNonEmptyString),
  contextWindow: Schema.NullOr(PositiveInt),
  /**
   * Reasoning effort as a *resolved human label*, never a raw field.
   *
   * Effort is not first-class anywhere: it is a provider-declared option
   * descriptor whose id differs per driver (`reasoningEffort` on Codex,
   * `reasoning` on Cursor, prompt-injected for Claude). The server resolves it
   * with `getProviderOptionCurrentLabel` and sends the label, so clients never
   * have to know each driver's option vocabulary.
   */
  reasoningEffortLabel: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProviderInstanceModelInfo = typeof ProviderInstanceModelInfo.Type;

export const ProviderInstanceDescription = Schema.Struct({
  identity: ProviderInstanceIdentity,
  connection: ProviderInstanceConnection,
  model: Schema.NullOr(ProviderInstanceModelInfo),
  /** Metadata only — bodies are fetched per skill via `provider.getSkillBody`. */
  skills: Schema.Array(ServerProviderSkill),
  /**
   * Free-form capability flags the driver reports about itself. Opaque at the
   * contracts layer for the same reason driver config is (see
   * `providerInstance.ts`): capability vocabularies belong to drivers.
   */
  capabilities: Schema.NullOr(Schema.Record(Schema.String, Schema.Boolean)),
  describedAt: IsoDateTime,
});
export type ProviderInstanceDescription = typeof ProviderInstanceDescription.Type;

export const ProviderDescribeInstanceInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderDescribeInstanceInput = typeof ProviderDescribeInstanceInput.Type;

export const ProviderGetSkillBodyInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  skillName: TrimmedNonEmptyString,
});
export type ProviderGetSkillBodyInput = typeof ProviderGetSkillBodyInput.Type;

export const ProviderSkillBody = Schema.Struct({
  skillName: TrimmedNonEmptyString,
  /** Null when the driver knows the skill but cannot produce its body. */
  markdown: Schema.NullOr(Schema.String),
});
export type ProviderSkillBody = typeof ProviderSkillBody.Type;

export const ProviderDescribeErrorCode = Schema.Literals([
  "instance-not-found",
  "unsupported",
  "unavailable",
  "internal-error",
]);
export type ProviderDescribeErrorCode = typeof ProviderDescribeErrorCode.Type;

export class ProviderDescribeError extends Schema.TaggedErrorClass<ProviderDescribeError>()(
  "ProviderDescribeError",
  {
    code: ProviderDescribeErrorCode,
    message: TrimmedNonEmptyString,
    instanceId: Schema.optional(ProviderInstanceId),
  },
) {}

export const ProviderEnsureAgentProjectInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderEnsureAgentProjectInput = typeof ProviderEnsureAgentProjectInput.Type;

/**
 * The synthetic project backing one instance's directoryless threads.
 *
 * Returned by an idempotent get-or-create, so callers treat it as a
 * precondition to resolve rather than a resource to manage: it is safe to ask
 * for on every thread start, and a missing or soft-deleted row heals itself
 * instead of leaving the instance permanently unusable.
 */
export const ProviderAgentProjectResult = Schema.Struct({
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  workspaceRoot: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
});
export type ProviderAgentProjectResult = typeof ProviderAgentProjectResult.Type;
