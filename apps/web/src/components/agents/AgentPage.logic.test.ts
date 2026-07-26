import type {
  ProviderInstanceDescription,
  ProviderInstanceId,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_FIELD_NOT_REPORTED,
  agentCapabilityEntries,
  agentPageTitle,
  agentStatusBadgeVariant,
  agentStatusDotStyleKey,
  agentStatusGuidance,
  agentStatusLabel,
  filterAgentSkills,
  formatAgentCapabilityLabel,
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
  resolveAgentRouteInstanceId,
  shouldFetchAgentSkillBody,
  supportsGatewayReconnect,
  upsertAgentSkillBody,
  type AgentConnectionStatus,
  type AgentSkillBodyCache,
} from "./AgentPage.logic";

const ALL_STATUSES: ReadonlyArray<AgentConnectionStatus> = [
  "ready",
  "connecting",
  "offline",
  "error",
  "disabled",
];

function makeSkill(
  overrides: Partial<ServerProviderSkill> & { name: string },
): ServerProviderSkill {
  return {
    path: `/home/agent/.agents/skills/${overrides.name}/SKILL.md`,
    enabled: true,
    ...overrides,
  } as ServerProviderSkill;
}

function makeDescription(
  overrides: Partial<ProviderInstanceDescription> = {},
): ProviderInstanceDescription {
  return {
    identity: {
      instanceId: "hermes-main" as ProviderInstanceId,
      driver: "hermes",
      displayName: "Hermes Main",
      agentVersion: "0.19.0",
      pluginVersion: "v1.2.0",
      protocolVersion: 2,
      host: "hermes.example.com",
    },
    connection: {
      status: "ready",
      detail: null,
      lastConnectedAt: "2026-07-25T12:00:00.000Z",
      activeSessionCount: 0,
      connectionGeneration: 3,
    },
    model: {
      id: "gpt-5.6-terra",
      displayName: "GPT-5.6 Terra",
      vendor: "OpenAI",
      contextWindow: 400_000,
      reasoningEffortLabel: "High",
    },
    skills: [],
    capabilities: null,
    describedAt: "2026-07-25T12:05:00.000Z",
    ...overrides,
  } as ProviderInstanceDescription;
}

describe("agent status presentation", () => {
  it("maps every connection status to a badge variant", () => {
    expect(ALL_STATUSES.map(agentStatusBadgeVariant)).toEqual([
      "success",
      "warning",
      "secondary",
      "error",
      "secondary",
    ]);
  });

  it("labels every connection status", () => {
    expect(ALL_STATUSES.map(agentStatusLabel)).toEqual([
      "Connected",
      "Connecting",
      "Offline",
      "Error",
      "Disabled",
    ]);
  });

  it("treats offline as actionable rather than neutral in the status dot", () => {
    expect(ALL_STATUSES.map(agentStatusDotStyleKey)).toEqual([
      "ready",
      "warning",
      "warning",
      "error",
      "disabled",
    ]);
  });

  it("gives distinct, non-empty guidance for every status", () => {
    const guidance = ALL_STATUSES.map(agentStatusGuidance);
    expect(guidance.every((entry) => entry.trim().length > 0)).toBe(true);
    expect(new Set(guidance).size).toBe(ALL_STATUSES.length);
  });
});

describe("agent field formatting", () => {
  it("renders an explicit not-reported state instead of a plausible blank", () => {
    expect(formatAgentText(null)).toBe(AGENT_FIELD_NOT_REPORTED);
    expect(formatAgentText(undefined)).toBe(AGENT_FIELD_NOT_REPORTED);
    expect(formatAgentText("   ")).toBe(AGENT_FIELD_NOT_REPORTED);
    expect(formatAgentText("  hermes.example.com ")).toBe("hermes.example.com");
  });

  it("keeps zero as a real reading for counts", () => {
    expect(formatAgentCount(0)).toBe("0");
    expect(formatAgentCount(1234)).toBe("1,234");
    expect(formatAgentCount(null)).toBe(AGENT_FIELD_NOT_REPORTED);
    expect(formatAgentCount(undefined)).toBe(AGENT_FIELD_NOT_REPORTED);
  });

  it("formats context windows with a unit", () => {
    expect(formatAgentContextWindow(400_000)).toBe("400,000 tokens");
    expect(formatAgentContextWindow(null)).toBe(AGENT_FIELD_NOT_REPORTED);
  });

  it("prefixes protocol versions", () => {
    expect(formatAgentProtocolVersion(2)).toBe("v2");
    expect(formatAgentProtocolVersion(null)).toBe(AGENT_FIELD_NOT_REPORTED);
  });

  it("normalizes bare and prefixed versions the same way settings does", () => {
    expect(formatAgentVersion("0.19.0")).toBe("v0.19.0");
    expect(formatAgentVersion("v0.19.0")).toBe("v0.19.0");
    expect(formatAgentVersion(null)).toBe(AGENT_FIELD_NOT_REPORTED);
    expect(formatAgentVersion("")).toBe(AGENT_FIELD_NOT_REPORTED);
  });

  it("formats timestamps and echoes unparseable ones verbatim", () => {
    expect(formatAgentTimestamp(null)).toBe(AGENT_FIELD_NOT_REPORTED);
    expect(formatAgentTimestamp("  ")).toBe(AGENT_FIELD_NOT_REPORTED);
    expect(formatAgentTimestamp("not-a-date")).toBe("not-a-date");
    expect(formatAgentTimestamp("2026-07-25T12:00:00.000Z")).toBe(
      new Date("2026-07-25T12:00:00.000Z").toLocaleString(),
    );
  });
});

describe("agentPageTitle", () => {
  it("prefers the reported display name", () => {
    expect(agentPageTitle(makeDescription(), "hermes-main")).toBe("Hermes Main");
  });

  it("falls back to the routed instance id before the first describe lands", () => {
    expect(agentPageTitle(null, "hermes-main")).toBe("hermes-main");
  });

  it("falls back when the display name is only whitespace", () => {
    const description = makeDescription({
      identity: { ...makeDescription().identity, displayName: "   " },
    } as Partial<ProviderInstanceDescription>);
    expect(agentPageTitle(description, "hermes-main")).toBe("hermes-main");
  });
});

describe("filterAgentSkills", () => {
  const skills = [
    makeSkill({ name: "deploy", displayName: "Deploy" }),
    makeSkill({ name: "review-pr", shortDescription: "Review a pull request" }),
    makeSkill({ name: "legacy-tool", enabled: false }),
  ];

  it("shows every reported skill, disabled included, when the filter is empty", () => {
    expect(filterAgentSkills(skills, "").map((skill) => skill.name)).toEqual([
      "deploy",
      "review-pr",
      "legacy-tool",
    ]);
    expect(filterAgentSkills(skills, "   ").length).toBe(3);
  });

  it("ranks with the shared skill search once a query is typed", () => {
    expect(filterAgentSkills(skills, "deploy").map((skill) => skill.name)).toEqual(["deploy"]);
    expect(filterAgentSkills(skills, "pull request").map((skill) => skill.name)).toEqual([
      "review-pr",
    ]);
  });

  it("returns nothing for a query nothing matches", () => {
    expect(filterAgentSkills(skills, "zzzzz")).toEqual([]);
  });
});

describe("agentCapabilityEntries", () => {
  it("returns nothing when the driver reported no capability struct", () => {
    expect(agentCapabilityEntries(null)).toEqual([]);
    expect(agentCapabilityEntries(undefined)).toEqual([]);
  });

  it("sorts by key so chip order does not churn between describes", () => {
    expect(
      agentCapabilityEntries({ streaming: true, approvals: false, sessionResume: true }).map(
        (entry) => entry.key,
      ),
    ).toEqual(["approvals", "sessionResume", "streaming"]);
  });

  it("carries the enabled flag through", () => {
    expect(agentCapabilityEntries({ approvals: false, streaming: true })).toEqual([
      { key: "approvals", label: "Approvals", enabled: false },
      { key: "streaming", label: "Streaming", enabled: true },
    ]);
  });
});

describe("formatAgentCapabilityLabel", () => {
  it("humanizes camel, snake, and kebab keys alike", () => {
    expect(formatAgentCapabilityLabel("sessionResume")).toBe("Session resume");
    expect(formatAgentCapabilityLabel("session_resume")).toBe("Session resume");
    expect(formatAgentCapabilityLabel("session-resume")).toBe("Session resume");
    expect(formatAgentCapabilityLabel("streaming")).toBe("Streaming");
  });

  it("returns the raw key when there is nothing to humanize", () => {
    expect(formatAgentCapabilityLabel("__")).toBe("__");
  });
});

describe("skill body cache", () => {
  it("inserts without mutating the previous map", () => {
    const first: AgentSkillBodyCache = new Map();
    const second = upsertAgentSkillBody(first, "deploy", { status: "loading" });
    expect(first.size).toBe(0);
    expect(second.get("deploy")).toEqual({ status: "loading" });

    const third = upsertAgentSkillBody(second, "deploy", { status: "loaded", markdown: "# Hi" });
    expect(second.get("deploy")).toEqual({ status: "loading" });
    expect(third.get("deploy")).toEqual({ status: "loaded", markdown: "# Hi" });
  });

  it("never re-fetches a settled body but retries a failed one", () => {
    const cache: AgentSkillBodyCache = new Map([
      ["loaded", { status: "loaded", markdown: "# Hi" } as const],
      ["empty", { status: "loaded", markdown: null } as const],
      ["pending", { status: "loading" } as const],
      ["failed", { status: "error", message: "boom" } as const],
    ]);
    expect(shouldFetchAgentSkillBody(cache, "loaded")).toBe(false);
    expect(shouldFetchAgentSkillBody(cache, "empty")).toBe(false);
    expect(shouldFetchAgentSkillBody(cache, "pending")).toBe(false);
    expect(shouldFetchAgentSkillBody(cache, "failed")).toBe(true);
    expect(shouldFetchAgentSkillBody(cache, "never-seen")).toBe(true);
  });
});

describe("nextExpandedSkillName", () => {
  it("behaves as an accordion", () => {
    expect(nextExpandedSkillName(null, "deploy")).toBe("deploy");
    expect(nextExpandedSkillName("deploy", "review-pr")).toBe("review-pr");
    expect(nextExpandedSkillName("deploy", "deploy")).toBe(null);
  });
});

describe("page action state", () => {
  it("treats any pending action as busy", () => {
    expect(isAgentPageBusy(null)).toBe(false);
    expect(isAgentPageBusy("describe")).toBe(true);
    expect(isAgentPageBusy("reconnect")).toBe(true);
    expect(isAgentPageBusy("newThread")).toBe(true);
  });

  it("only consults gateway status for remote-gateway drivers", () => {
    expect(supportsGatewayReconnect("hermes")).toBe(true);
    expect(supportsGatewayReconnect("codex")).toBe(false);
    expect(supportsGatewayReconnect(null)).toBe(false);
    expect(supportsGatewayReconnect(undefined)).toBe(false);
  });
});

describe("error coercion", () => {
  it("prefers a real message from every shape a failure can take", () => {
    expect(messageFromAgentPageError(new Error("Socket closed"))).toBe("Socket closed");
    expect(messageFromAgentPageError({ code: "unsupported", message: "No describe" })).toBe(
      "No describe",
    );
    expect(messageFromAgentPageError("plain string failure")).toBe("plain string failure");
  });

  it("falls back for empty and structureless failures", () => {
    const fallback = "Could not read this agent's details.";
    expect(messageFromAgentPageError(new Error("   "))).toBe(fallback);
    expect(messageFromAgentPageError({ message: "  " })).toBe(fallback);
    expect(messageFromAgentPageError(null)).toBe(fallback);
    expect(messageFromAgentPageError(undefined)).toBe(fallback);
    expect(messageFromAgentPageError(42)).toBe(fallback);
  });

  it("recognizes only the structured missing-instance code", () => {
    expect(isAgentInstanceNotFoundError({ code: "instance-not-found" })).toBe(true);
    expect(isAgentInstanceNotFoundError({ code: "unsupported" })).toBe(false);
    expect(isAgentInstanceNotFoundError(new Error("instance-not-found"))).toBe(false);
    expect(isAgentInstanceNotFoundError(null)).toBe(false);
  });
});

describe("resolveAgentRouteInstanceId", () => {
  it("resolves a present param", () => {
    expect(resolveAgentRouteInstanceId({ instanceId: "hermes-main" })).toBe("hermes-main");
    expect(resolveAgentRouteInstanceId({ instanceId: "  hermes-main  " })).toBe("hermes-main");
  });

  it("returns null for missing or blank params", () => {
    expect(resolveAgentRouteInstanceId({})).toBe(null);
    expect(resolveAgentRouteInstanceId({ instanceId: undefined })).toBe(null);
    expect(resolveAgentRouteInstanceId({ instanceId: "   " })).toBe(null);
  });
});
