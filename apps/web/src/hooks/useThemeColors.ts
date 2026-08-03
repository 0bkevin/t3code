import { useCallback, useSyncExternalStore } from "react";

export type ThemeColors = {
  accentColor: string;
  neutralColor: string;
};

export const DEFAULT_THEME_COLORS: ThemeColors = {
  accentColor: "#3b5bdb",
  neutralColor: "#737373",
};

export const THEME_COLORS_STORAGE_KEY = "t3code:theme-colors";

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const listeners = new Set<() => void>();
let currentColors = readThemeColors();

export function normalizeThemeColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return HEX_COLOR_PATTERN.test(normalized) ? normalized : undefined;
}

export function normalizeThemeColors(value: unknown): ThemeColors {
  const colors = value && typeof value === "object" ? (value as Partial<ThemeColors>) : {};
  return {
    accentColor: normalizeThemeColor(colors.accentColor) ?? DEFAULT_THEME_COLORS.accentColor,
    neutralColor: normalizeThemeColor(colors.neutralColor) ?? DEFAULT_THEME_COLORS.neutralColor,
  };
}

export function readThemeColors(): ThemeColors {
  if (typeof window === "undefined") return DEFAULT_THEME_COLORS;
  try {
    const stored = window.localStorage.getItem(THEME_COLORS_STORAGE_KEY);
    return stored ? normalizeThemeColors(JSON.parse(stored)) : DEFAULT_THEME_COLORS;
  } catch {
    return DEFAULT_THEME_COLORS;
  }
}

export function applyThemeColors(colors: ThemeColors): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--theme-accent-seed", colors.accentColor);
  document.documentElement.style.setProperty("--theme-neutral-seed", colors.neutralColor);
}

function emitChange(): void {
  for (const listener of listeners) listener();
}

function persistThemeColors(colors: ThemeColors): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_COLORS_STORAGE_KEY, JSON.stringify(colors));
  } catch {
    // The colors still apply for this session when storage is unavailable.
  }
}

function setCurrentColors(colors: ThemeColors): void {
  currentColors = colors;
  applyThemeColors(colors);
  emitChange();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== "undefined") {
  applyThemeColors(currentColors);
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_COLORS_STORAGE_KEY) setCurrentColors(readThemeColors());
  });
}

export function useThemeColors() {
  const colors = useSyncExternalStore(
    subscribe,
    () => currentColors,
    () => DEFAULT_THEME_COLORS,
  );

  const setThemeColors = useCallback((value: ThemeColors) => {
    const normalized = normalizeThemeColors(value);
    persistThemeColors(normalized);
    setCurrentColors(normalized);
  }, []);

  return { colors, setThemeColors } as const;
}
