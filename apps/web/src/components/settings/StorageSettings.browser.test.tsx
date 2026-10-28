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
  state.update.mockReset().mockResolvedValue(undefined);
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

function ruleIsMixed(container: HTMLElement, title: string) {
  return Array.from(container.querySelectorAll("h3"))
    .find((heading) => heading.textContent === title)
    ?.parentElement?.textContent?.includes("Mixed across selected machines");
}

const artifactIsMixed = (container: HTMLElement) =>
  ruleIsMixed(container, "Delete old browser artifacts");
const logsAreMixed = (container: HTMLElement) => ruleIsMixed(container, "Delete old rotated logs");

function deferredSave() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function stepArtifacts(container: HTMLElement, direction: "Increase" | "Decrease") {
  container
    .querySelector<HTMLButtonElement>(`[aria-label="${direction} Delete old browser artifacts"]`)!
    .click();
}

it("does not add a mixed warning before every machine projects a completed save", async () => {
  setup();
  setArtifactRetention(0, 9);
  setArtifactRetention(1, 9);
  const save = deferredSave();
  state.update.mockReturnValue(save.promise);
  await using screen = await render(panel());
  expect(artifactIsMixed(screen.container)).toBe(false);

  await act(async () => stepArtifacts(screen.container, "Increase"));
  setArtifactRetention(0, 10);
  const machineB = state.targets[1]!;
  machineB.settings = {
    ...machineB.settings,
    storageCleanup: { ...machineB.settings.storageCleanup, logsAfterDays: 30 },
  };
  await act(async () => save.resolve());
  await screen.rerender(panel());
  expect(artifactIsMixed(screen.container)).toBe(false);
  expect(logsAreMixed(screen.container)).toBe(true);

  setArtifactRetention(1, 10);
  await screen.rerender(panel());
  expect(artifactIsMixed(screen.container)).toBe(false);

  setArtifactRetention(1, 11);
  await screen.rerender(panel());
  expect(artifactIsMixed(screen.container)).toBe(true);
});

it.each([14, 30])(
  "shows genuine differences after a partial save fails with a second value of %i",
  async (secondValue) => {
    setup();
    setArtifactRetention(0, 14);
    setArtifactRetention(1, secondValue);
    const save = deferredSave();
    let onFailed!: () => void;
    state.update.mockImplementation((_patch, options) => {
      onFailed = options.onFailed;
      return save.promise;
    });
    await using screen = await render(panel());
    expect(artifactIsMixed(screen.container)).toBe(secondValue !== 14);

    await act(async () => retentionSwitch(screen.container).click());
    setArtifactRetention(0, null);
    await screen.rerender(panel());
    expect(artifactIsMixed(screen.container)).toBe(secondValue !== 14);

    await act(async () => {
      onFailed();
      save.resolve();
    });
    expect(artifactIsMixed(screen.container)).toBe(true);
  },
);

it("keeps a reversed edit pending and ignores a superseded save failure", async () => {
  setup();
  setArtifactRetention(0, 9);
  setArtifactRetention(1, 9);
  const first = deferredSave();
  const second = deferredSave();
  let failFirst!: () => void;
  state.update
    .mockImplementationOnce((_patch, options) => {
      failFirst = options.onFailed;
      return first.promise;
    })
    .mockReturnValueOnce(second.promise);
  await using screen = await render(panel());
  await act(async () => stepArtifacts(screen.container, "Increase"));
  await act(async () => stepArtifacts(screen.container, "Decrease"));

  setArtifactRetention(0, 10);
  await screen.rerender(panel());
  expect(artifactIsMixed(screen.container)).toBe(false);
  await act(async () => {
    failFirst();
    first.resolve();
  });
  expect(artifactIsMixed(screen.container)).toBe(false);

  setArtifactRetention(0, 9);
  setArtifactRetention(1, 10);
  await act(async () => second.resolve());
  await screen.rerender(panel());
  expect(artifactIsMixed(screen.container)).toBe(false);
  setArtifactRetention(1, 9);
  await screen.rerender(panel());
  expect(artifactIsMixed(screen.container)).toBe(false);

  setArtifactRetention(1, 12);
  await screen.rerender(panel());
  expect(artifactIsMixed(screen.container)).toBe(true);
});

it("uses the newly selected machines rather than an older pending edit", async () => {
  setup();
  const save = deferredSave();
  state.update.mockReturnValue(save.promise);
  await using screen = await render(panel());
  await act(async () => retentionSwitch(screen.container).click());
  setArtifactRetention(0, 8);
  state.targets[1] = { ...state.targets[1]!, environmentId: "machine-c" };
  setArtifactRetention(1, 30);
  await screen.rerender(panel());
  expect(artifactIsMixed(screen.container)).toBe(true);
  await act(async () => save.resolve());
  expect(artifactIsMixed(screen.container)).toBe(true);
});
