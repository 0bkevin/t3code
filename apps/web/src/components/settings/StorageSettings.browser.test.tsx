import { act, render } from "../../../test/render";
import { RegistryProvider } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type StorageCleanupReport } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  targets: [] as {
    environmentId: string;
    settings: typeof DEFAULT_SERVER_SETTINGS;
  }[],
  run: vi.fn(),
  update: vi.fn(),
  report: null as StorageCleanupReport | null,
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const report = Atom.make(() => ({ _tag: "Success", value: state.report, waiting: false }));
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      storageCleanupReport: (() => report) as never,
      runStorageCleanup: {
        ...actual.serverEnvironment.runStorageCleanup,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.run) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environments = state.targets.map(({ environmentId, settings }) => ({
      environmentId,
      label: environmentId,
      serverConfig: {
        settings,
        environment: {
          capabilities: {
            storageCleanup: true,
            storageCleanupRun: true,
            settledWorktreeCleanup: true,
          },
        },
      },
    }));
    return {
      scope: { kind: "all" },
      environments,
      connectedEnvironments: environments,
      targets: state.targets.map(({ environmentId, settings }) => ({
        environmentId,
        settings,
      })),
      target: state.targets[0] ? { settings: state.targets[0].settings } : null,
    };
  }) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.update,
  useClearScopedSettings: () => vi.fn(),
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
  SettingsRow: ({ title, description, status, control, children }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {status}
      {control}
      {children}
    </div>
  ),
  SettingResetButton: (() => null) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: vi.fn() } };
});

import { StorageCleanupSections } from "./StorageSettings";

function setup() {
  state.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    storageCleanup: {
      worktreeKeepWhen: "uncommitted-changes",
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    },
    projectSettingsOverrides: {},
  };
  state.report = null;
  state.run.mockReset();
  state.targets = [
    { environmentId: "machine-a", settings: state.settings },
    {
      environmentId: "machine-b",
      settings: {
        ...state.settings,
        storageCleanup: { ...state.settings.storageCleanup },
      },
    },
  ];
  state.update.mockReset();
}

const panel = () => (
  <RegistryProvider>
    <StorageCleanupSections />
  </RegistryProvider>
);
const deleteButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Delete now",
  )!;

it("keeps cleanup disabled when settled retention and all other rules are off", async () => {
  setup();
  await using screen = await render(panel());
  const button = deleteButton(screen.container);

  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(state.run).not.toHaveBeenCalled();
});

function setArtifactRetention(machineIndex: number, value: number | null) {
  const target = state.targets[machineIndex]!;
  target.settings = {
    ...target.settings,
    storageCleanup: { ...target.settings.storageCleanup, browserArtifactsAfterDays: value },
  };
  if (machineIndex === 0) state.settings = target.settings;
}

function retentionSwitch(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find(
    (control) => control.getAttribute("aria-label") === "Delete old browser artifacts",
  )!;
}

function artifactStatus(container: HTMLElement) {
  const title = Array.from(container.querySelectorAll("h3")).find(
    (heading) => heading.textContent === "Delete old browser artifacts",
  );
  return title?.parentElement?.querySelector("span[aria-hidden]") as HTMLSpanElement;
}

function logsStatus(container: HTMLElement) {
  const title = Array.from(container.querySelectorAll("h3")).find(
    (heading) => heading.textContent === "Delete old rotated logs",
  );
  return title?.parentElement?.querySelector("span[aria-hidden]") as HTMLSpanElement;
}

it("keeps a uniform retention rule free of a transient mixed warning while machines save", async () => {
  setup();
  setArtifactRetention(0, 9);
  setArtifactRetention(1, 9);
  let onSettled: (() => void) | undefined;
  state.update.mockImplementation((_patch, options) => {
    onSettled = options?.onSettled;
  });

  await using screen = await render(panel());
  expect(artifactStatus(screen.container).getAttribute("aria-hidden")).toBe("true");

  await act(async () =>
    screen.container
      .querySelector<HTMLButtonElement>('[aria-label="Increase Delete old browser artifacts"]')!
      .click(),
  );
  setArtifactRetention(0, 10);
  const machineB = state.targets[1]!;
  machineB.settings = {
    ...machineB.settings,
    storageCleanup: { ...machineB.settings.storageCleanup, logsAfterDays: 30 },
  };
  await screen.rerender(panel());

  expect(artifactStatus(screen.container).getAttribute("aria-hidden")).toBe("true");
  expect(logsStatus(screen.container).getAttribute("aria-hidden")).toBe("false");

  setArtifactRetention(1, 10);
  await act(async () => onSettled?.());
  await screen.rerender(panel());

  expect(artifactStatus(screen.container).getAttribute("aria-hidden")).toBe("true");
  expect(logsStatus(screen.container).getAttribute("aria-hidden")).toBe("false");
});

it.each([14, 30])(
  "shows genuine differences after a partial save with a second value of %i",
  async (secondValue) => {
    setup();
    setArtifactRetention(0, 14);
    setArtifactRetention(1, secondValue);
    let onSettled: (() => void) | undefined;
    state.update.mockImplementation((_patch, options) => {
      onSettled = options?.onSettled;
    });

    await using screen = await render(panel());
    expect(artifactStatus(screen.container).getAttribute("aria-hidden")).toBe(
      String(secondValue === 14),
    );

    await act(async () => retentionSwitch(screen.container).click());
    setArtifactRetention(0, null);
    await screen.rerender(panel());
    expect(artifactStatus(screen.container).getAttribute("aria-hidden")).toBe(
      String(secondValue === 14),
    );

    await act(async () => onSettled?.());
    await screen.rerender(panel());
    expect(artifactStatus(screen.container).getAttribute("aria-hidden")).toBe("false");
  },
);

it("keeps the starting status until overlapping saves for the selected machines settle", async () => {
  setup();
  const onSettled: (() => void)[] = [];
  state.update.mockImplementation((_patch, options) => {
    if (options?.onSettled) onSettled.push(options.onSettled);
  });

  await using screen = await render(panel());
  await act(async () => retentionSwitch(screen.container).click());
  setArtifactRetention(0, 8);
  await screen.rerender(panel());
  await act(async () => retentionSwitch(screen.container).click());
  setArtifactRetention(0, null);
  setArtifactRetention(1, 8);
  await screen.rerender(panel());

  expect(onSettled).toHaveLength(2);
  expect(artifactStatus(screen.container).getAttribute("aria-hidden")).toBe("true");
  await act(async () => onSettled[0]!());
  expect(artifactStatus(screen.container).getAttribute("aria-hidden")).toBe("true");

  setArtifactRetention(1, null);
  await act(async () => onSettled[1]!());
  await screen.rerender(panel());
  expect(artifactStatus(screen.container).getAttribute("aria-hidden")).toBe("true");
});

it("derives mixed status from a newly selected machine set during an older save", async () => {
  setup();
  let onSettled: (() => void) | undefined;
  state.update.mockImplementation((_patch, options) => {
    onSettled = options?.onSettled;
  });

  await using screen = await render(panel());
  await act(async () => retentionSwitch(screen.container).click());
  setArtifactRetention(0, 8);
  state.targets[1] = {
    ...state.targets[1]!,
    environmentId: "machine-c",
    settings: {
      ...state.targets[1]!.settings,
      storageCleanup: { ...state.targets[1]!.settings.storageCleanup },
    },
  };
  setArtifactRetention(1, 30);
  await screen.rerender(panel());

  expect(artifactStatus(screen.container).getAttribute("aria-hidden")).toBe("false");
  await act(async () => onSettled?.());
  await screen.rerender(panel());
  expect(artifactStatus(screen.container).getAttribute("aria-hidden")).toBe("false");
});
