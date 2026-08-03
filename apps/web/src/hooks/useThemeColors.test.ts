import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => store.delete(key),
    setItem: (key, value) => store.set(key, value),
  };
}

function createWindow(initial: Record<string, string> = {}) {
  return { addEventListener: vi.fn(), localStorage: createStorage(initial) };
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme colors", () => {
  it("normalizes valid colors and falls back per invalid color", async () => {
    vi.stubGlobal("window", createWindow());
    const { normalizeThemeColors } = await import("./useThemeColors");

    expect(normalizeThemeColors({ accentColor: " #DB2777 ", neutralColor: "not-a-color" })).toEqual(
      { accentColor: "#db2777", neutralColor: "#737373" },
    );
  });

  it("reads a valid palette from storage", async () => {
    vi.stubGlobal(
      "window",
      createWindow({
        "t3code:theme-colors": JSON.stringify({
          accentColor: "#0891b2",
          neutralColor: "#57534e",
        }),
      }),
    );
    const { readThemeColors } = await import("./useThemeColors");

    expect(readThemeColors()).toEqual({ accentColor: "#0891b2", neutralColor: "#57534e" });
  });

  it("applies both seeds to the document root", async () => {
    const setProperty = vi.fn();
    vi.stubGlobal("window", createWindow());
    vi.stubGlobal("document", { documentElement: { style: { setProperty } } });
    const { applyThemeColors } = await import("./useThemeColors");

    applyThemeColors({ accentColor: "#16a34a", neutralColor: "#78716c" });

    expect(setProperty).toHaveBeenCalledWith("--theme-accent-seed", "#16a34a");
    expect(setProperty).toHaveBeenCalledWith("--theme-neutral-seed", "#78716c");
  });
});
