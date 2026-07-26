"use client";

import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ProviderInstanceDescription,
  ProviderInstanceId,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CpuIcon,
  LoaderIcon,
  MessageSquarePlusIcon,
  PlugZapIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { cn } from "../../lib/utils";
import { formatProviderDriverKindLabel } from "../../providerModels";
import {
  formatProviderSkillDisplayName,
  formatProviderSkillInstallSource,
} from "../../providerSkillPresentation";
import { usePrimaryEnvironment } from "../../state/environments";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { hermesGatewayProviderSignal } from "../settings/HermesGatewayInstanceSection.logic";
import { PROVIDER_STATUS_STYLES } from "../settings/providerStatus";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import {
  AGENT_FIELD_NOT_REPORTED,
  agentCapabilityEntries,
  agentPageTitle,
  agentStatusBadgeVariant,
  agentStatusDotStyleKey,
  agentStatusGuidance,
  agentStatusLabel,
  filterAgentSkills,
  formatAgentContextWindow,
  formatAgentCount,
  formatAgentProtocolVersion,
  formatAgentText,
  formatAgentTimestamp,
  formatAgentVersion,
  isAgentInstanceNotFoundError,
  isAgentPageBusy,
  messageFromAgentPageError,
  nextExpandedSkillName,
  shouldFetchAgentSkillBody,
  supportsGatewayReconnect,
  upsertAgentSkillBody,
  type AgentPageAction,
  type AgentSkillBodyCache,
  type AgentSkillBodyEntry,
} from "./AgentPage.logic";

function DefinitionField({ label, value }: { label: string; value: string }) {
  const isMissing = value === AGENT_FIELD_NOT_REPORTED;
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "truncate",
          isMissing ? "text-muted-foreground/70 italic" : "text-foreground",
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/15 p-3 sm:p-4">{children}</div>
  );
}

function AgentSkillRow(props: {
  readonly skill: ServerProviderSkill;
  readonly isExpanded: boolean;
  readonly body: AgentSkillBodyEntry | undefined;
  readonly onToggle: (skillName: string) => void;
}) {
  const { skill, isExpanded, body } = props;
  const sourceLabel = formatProviderSkillInstallSource(skill);
  const description = skill.shortDescription?.trim() || skill.description?.trim() || null;

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        aria-expanded={isExpanded}
        className="flex w-full items-start gap-2 px-2 py-2.5 text-left hover:bg-accent/40"
        onClick={() => props.onToggle(skill.name)}
      >
        <ChevronRightIcon
          className={cn(
            "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
            isExpanded && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            {/* Skill names are agent-authored and can be long and unbroken;
                `flex-wrap` alone cannot split a single word. */}
            <span className="min-w-0 break-all text-sm font-medium text-foreground">
              {formatProviderSkillDisplayName(skill)}
            </span>
            {sourceLabel ? (
              <Badge variant="outline" size="sm">
                {sourceLabel}
              </Badge>
            ) : null}
            {skill.enabled ? null : (
              <Badge variant="secondary" size="sm">
                Disabled
              </Badge>
            )}
          </span>
          {/* Hard one-line clamp with an ellipsis. Descriptions are
              agent-authored and unbounded — this one must never set the row's
              width, so `w-full` pins it to the (already shrinkable) parent
              rather than letting it size to its content. Full text is on the
              title attribute and in the expanded body. */}
          <span
            className="mt-0.5 block w-full truncate text-xs text-muted-foreground"
            title={description ?? skill.name}
          >
            {description ?? skill.name}
          </span>
        </span>
      </button>
      {isExpanded ? (
        // `min-w-0` matters here: a skill body is arbitrary authored markdown,
        // so it can contain a wide code fence or an unbroken URL. Without it
        // that content sets the row's width and pushes the whole page sideways.
        <div className="min-w-0 overflow-x-auto px-2 pb-3 pl-7">
          {body === undefined || body.status === "loading" ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <LoaderIcon className="size-3.5 animate-spin" />
              Loading skill…
            </p>
          ) : body.status === "error" ? (
            <p className="text-xs text-destructive">{body.message}</p>
          ) : body.markdown === null || body.markdown.trim() === "" ? (
            <p className="text-xs text-muted-foreground/70 italic">
              This agent knows the skill but did not return its contents.
            </p>
          ) : (
            <ChatMarkdown text={body.markdown} cwd={undefined} className="max-w-none text-sm" />
          )}
        </div>
      ) : null}
    </div>
  );
}

export function AgentPage({ instanceId }: { readonly instanceId: ProviderInstanceId }) {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const providers = useAtomValue(primaryServerProvidersAtom);

  const describeInstance = useAtomCommand(serverEnvironment.providerDescribeInstance, {
    reportFailure: false,
  });
  const getSkillBody = useAtomCommand(serverEnvironment.providerGetSkillBody, {
    reportFailure: false,
  });
  const ensureAgentProject = useAtomCommand(serverEnvironment.providerEnsureAgentProject, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const getGatewayStatus = useAtomCommand(serverEnvironment.hermesGatewayGetInstanceStatus, {
    reportFailure: false,
  });

  const [description, setDescription] = useState<ProviderInstanceDescription | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [instanceNotFound, setInstanceNotFound] = useState(false);
  const [pendingAction, setPendingAction] = useState<AgentPageAction | null>(null);
  const [skillQuery, setSkillQuery] = useState("");
  const [expandedSkillName, setExpandedSkillName] = useState<string | null>(null);
  const [skillBodies, setSkillBodies] = useState<AgentSkillBodyCache>(() => new Map());

  const refresh = useCallback(
    async (quiet = false) => {
      if (environmentId === null) return;
      if (!quiet) setPendingAction("describe");
      const result = await describeInstance({ environmentId, input: { instanceId } });
      if (result._tag === "Success") {
        setDescription(result.value);
        setInstanceNotFound(false);
        setError(null);
      } else {
        const failure = squashAtomCommandFailure(result);
        if (isAgentInstanceNotFoundError(failure)) {
          setDescription(null);
          setInstanceNotFound(true);
          setError(null);
        } else if (!quiet) {
          setError(messageFromAgentPageError(failure));
        }
      }
      if (!quiet) setPendingAction(null);
    },
    [describeInstance, environmentId, instanceId],
  );

  // Initial read. Switching instances resets the page's per-skill state so a
  // cached body never bleeds across agents.
  useEffect(() => {
    setDescription(null);
    setSkillBodies(new Map());
    setExpandedSkillName(null);
    setSkillQuery("");
    void refresh();
  }, [refresh]);

  // Ambient liveness rides the push path: `subscribeServerConfig` already
  // republishes every `ServerProvider` when the broker changes state, so a
  // changed revision is the cue to re-read authoritative detail. No polling.
  const providerSignal = hermesGatewayProviderSignal(providers, instanceId);
  const lastSignalRevisionRef = useRef<string | null>(null);
  useEffect(() => {
    const revision = providerSignal.revision;
    if (revision === null) return;
    if (lastSignalRevisionRef.current === null) {
      lastSignalRevisionRef.current = revision;
      return;
    }
    if (lastSignalRevisionRef.current === revision) return;
    lastSignalRevisionRef.current = revision;
    void refresh(true);
  }, [providerSignal.revision, refresh]);

  const handleReconnect = async () => {
    if (environmentId === null) return;
    setPendingAction("reconnect");
    setError(null);
    // T3 never dials out to an agent — the plugin dials in. "Reconnect" is
    // therefore a forced re-probe: re-run the driver's status check, re-read
    // the authoritative gateway status where one exists, then re-describe.
    const refreshResult = await refreshProviders({ environmentId, input: { instanceId } });
    if (refreshResult._tag !== "Success") {
      setError(messageFromAgentPageError(squashAtomCommandFailure(refreshResult)));
      setPendingAction(null);
      return;
    }
    if (supportsGatewayReconnect(description?.identity.driver ?? null)) {
      const statusResult = await getGatewayStatus({ environmentId, input: { instanceId } });
      if (statusResult._tag === "Success") {
        toastManager.add({
          type: statusResult.value.status === "connected" ? "success" : "info",
          title: `Agent is ${statusResult.value.status}`,
          description:
            statusResult.value.status === "connected"
              ? "The gateway connection is live."
              : "T3 Code re-probed the gateway. The agent's plugin dials in on its own schedule.",
        });
      }
    }
    await refresh(true);
    setPendingAction(null);
  };

  const handleNewAgentThread = async () => {
    if (environmentId === null) return;
    setPendingAction("newThread");
    setError(null);
    // Get-or-create, never assume: the synthetic project may not exist yet,
    // or may have been soft-deleted, and this call heals either case.
    const result = await ensureAgentProject({ environmentId, input: { instanceId } });
    if (result._tag !== "Success") {
      setError(messageFromAgentPageError(squashAtomCommandFailure(result)));
      setPendingAction(null);
      return;
    }
    await handleNewThread(scopeProjectRef(environmentId, result.value.projectId));
    setPendingAction(null);
  };

  const handleToggleSkill = (skillName: string) => {
    const next = nextExpandedSkillName(expandedSkillName, skillName);
    setExpandedSkillName(next);
    if (next === null || environmentId === null) return;
    if (!shouldFetchAgentSkillBody(skillBodies, skillName)) return;
    setSkillBodies((cache) => upsertAgentSkillBody(cache, skillName, { status: "loading" }));
    void (async () => {
      const result = await getSkillBody({ environmentId, input: { instanceId, skillName } });
      setSkillBodies((cache) =>
        upsertAgentSkillBody(
          cache,
          skillName,
          result._tag === "Success"
            ? { status: "loaded", markdown: result.value.markdown }
            : {
                status: "error",
                message: messageFromAgentPageError(squashAtomCommandFailure(result)),
              },
        ),
      );
    })();
  };

  const status = description?.connection.status ?? "offline";
  const isBusy = isAgentPageBusy(pendingAction);
  const title = agentPageTitle(description, instanceId);
  const capabilities = useMemo(
    () => agentCapabilityEntries(description?.capabilities),
    [description?.capabilities],
  );
  const skills = description?.skills ?? [];
  const visibleSkills = useMemo(() => filterAgentSkills(skills, skillQuery), [skillQuery, skills]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      {/* `SettingsPageContainer` is `flex-1 overflow-y-auto`, and a flex child
          defaults to `min-height: auto` — without this `min-h-0` wrapper it
          refuses to shrink below its content, so the page grows past the
          `h-dvh overflow-hidden` inset instead of scrolling inside it. The
          settings route wraps its own `<Outlet/>` the same way. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SettingsPageContainer>
          <header className="space-y-3 px-3 sm:px-4">
            <div className="flex flex-wrap items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  PROVIDER_STATUS_STYLES[agentStatusDotStyleKey(status)].dot,
                )}
              />
              {/* Falls back to the instance id, which is an unbroken slug like
                  `hermes-siva-local-c9cc0b168af9` — at 2xl that overruns a
                  narrow viewport unless it is allowed to wrap mid-word. */}
              <h1 className="min-w-0 break-words text-2xl font-semibold tracking-[-0.025em] text-foreground">
                {title}
              </h1>
              <Badge variant={agentStatusBadgeVariant(status)} size="sm">
                {agentStatusLabel(status)}
              </Badge>
            </div>
            <p className="text-[13px] text-muted-foreground">
              {description?.connection.detail?.trim() || agentStatusGuidance(status)}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="default"
                disabled={isBusy || environmentId === null}
                onClick={() => void handleNewAgentThread()}
              >
                {pendingAction === "newThread" ? (
                  <LoaderIcon className="animate-spin" />
                ) : (
                  <MessageSquarePlusIcon />
                )}
                New thread
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isBusy || environmentId === null}
                onClick={() => void refresh()}
              >
                {pendingAction === "describe" ? (
                  <LoaderIcon className="animate-spin" />
                ) : (
                  <RefreshCwIcon />
                )}
                Refresh
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isBusy || environmentId === null}
                onClick={() => void handleReconnect()}
              >
                {pendingAction === "reconnect" ? (
                  <LoaderIcon className="animate-spin" />
                ) : (
                  <PlugZapIcon />
                )}
                Reconnect
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isBusy}
                onClick={() => void navigate({ to: "/settings/providers" })}
              >
                <SettingsIcon />
                Open settings
              </Button>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {instanceNotFound ? (
              <p className="text-xs text-muted-foreground">
                This server has no provider instance named <code>{instanceId}</code>. It may have
                been removed in provider settings.
              </p>
            ) : null}
          </header>

          <SettingsSection title="Status" icon={<ServerIcon className="size-4" />}>
            <SectionCard>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
                <DefinitionField label="Instance" value={instanceId} />
                <DefinitionField
                  label="Driver"
                  value={
                    description
                      ? formatProviderDriverKindLabel(description.identity.driver)
                      : AGENT_FIELD_NOT_REPORTED
                  }
                />
                <DefinitionField label="Host" value={formatAgentText(description?.identity.host)} />
                <DefinitionField
                  label="Last connected"
                  value={formatAgentTimestamp(description?.connection.lastConnectedAt)}
                />
                <DefinitionField
                  label="Active sessions"
                  value={formatAgentCount(description?.connection.activeSessionCount)}
                />
                <DefinitionField
                  label="Connection generation"
                  value={formatAgentCount(description?.connection.connectionGeneration)}
                />
                <DefinitionField
                  label="Agent version"
                  value={formatAgentVersion(description?.identity.agentVersion)}
                />
                <DefinitionField
                  label="Plugin version"
                  value={formatAgentVersion(description?.identity.pluginVersion)}
                />
                <DefinitionField
                  label="Protocol"
                  value={formatAgentProtocolVersion(description?.identity.protocolVersion)}
                />
                <DefinitionField
                  label="Described at"
                  value={formatAgentTimestamp(description?.describedAt)}
                />
              </dl>
              <div className="mt-3 border-t border-border/50 pt-3">
                <p className="text-xs text-muted-foreground">Reported capabilities</p>
                {capabilities.length === 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground/70 italic">
                    This agent did not report any capability flags.
                  </p>
                ) : (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {capabilities.map((capability) => (
                      <Badge
                        key={capability.key}
                        size="sm"
                        variant={capability.enabled ? "success" : "secondary"}
                      >
                        {capability.label}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </SectionCard>
          </SettingsSection>

          <SettingsSection title="Model" icon={<CpuIcon className="size-4" />}>
            <SectionCard>
              {description !== null && description.model === null ? (
                <p className="text-xs text-muted-foreground/70 italic">
                  This agent did not report a model.
                </p>
              ) : (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
                  <DefinitionField
                    label="Model"
                    value={formatAgentText(
                      description?.model?.displayName ?? description?.model?.id ?? null,
                    )}
                  />
                  <DefinitionField
                    label="Model id"
                    value={formatAgentText(description?.model?.id)}
                  />
                  <DefinitionField
                    label="Vendor"
                    value={formatAgentText(description?.model?.vendor)}
                  />
                  <DefinitionField
                    label="Reasoning effort"
                    value={formatAgentText(description?.model?.reasoningEffortLabel)}
                  />
                  <DefinitionField
                    label="Context window"
                    value={formatAgentContextWindow(description?.model?.contextWindow)}
                  />
                </dl>
              )}
            </SectionCard>
          </SettingsSection>

          <SettingsSection
            title="Skills"
            icon={<SparklesIcon className="size-4" />}
            headerAction={
              skills.length > 0 ? (
                <span className="text-xs text-muted-foreground">{skills.length}</span>
              ) : null
            }
          >
            <SectionCard>
              {skills.length === 0 ? (
                <p className="text-xs text-muted-foreground/70 italic">
                  This agent did not report any skills.
                </p>
              ) : (
                // `min-w-0` on the grid AND its items: a grid item's default
                // `min-width` is `auto`, so the list below sizes to its widest
                // skill description and the `truncate` inside never engages —
                // the row is already wider than the page by the time it applies.
                <div className="grid min-w-0 gap-2 [&>*]:min-w-0">
                  <div className="relative">
                    <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={skillQuery}
                      onChange={(event) => setSkillQuery(event.target.value)}
                      placeholder="Filter skills"
                      spellCheck={false}
                      className="pl-8"
                      aria-label="Filter skills"
                    />
                  </div>
                  {visibleSkills.length === 0 ? (
                    <p className="px-2 py-3 text-xs text-muted-foreground">
                      No skills match “{skillQuery}”.
                    </p>
                  ) : (
                    <div className="rounded-lg border border-border/60 bg-background/60">
                      {visibleSkills.map((skill) => (
                        <AgentSkillRow
                          key={skill.name}
                          skill={skill}
                          isExpanded={expandedSkillName === skill.name}
                          body={skillBodies.get(skill.name)}
                          onToggle={handleToggleSkill}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </SectionCard>
          </SettingsSection>

          <SettingsSection title="MCP servers" icon={<ServerIcon className="size-4" />}>
            <SectionCard>
              <p className="text-xs text-muted-foreground/70 italic">
                Not yet reported. No driver publishes its connected MCP servers today; this section
                fills in once they do.
              </p>
            </SectionCard>
          </SettingsSection>
        </SettingsPageContainer>
      </div>
    </SidebarInset>
  );
}

export default AgentPage;
