import { useCallback, useSyncExternalStore } from "react";

export type ThemeColors = {
  accentColor: string;
  neutralColor: string;
  contrast: number;
};

export const DEFAULT_THEME_COLORS: ThemeColors = {
  accentColor: "#3b5bdb",
  neutralColor: "#737373",
  contrast: 50,
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
    contrast:
      typeof colors.contrast === "number" && Number.isFinite(colors.contrast)
        ? Math.round(Math.min(100, Math.max(0, colors.contrast)))
        : DEFAULT_THEME_COLORS.contrast,
  };
}

export function getThemeAccentForeground(accentColor: string): "#000000" | "#ffffff" {
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(accentColor.slice(offset, offset + 2), 16),
  );
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance >= 0.179 ? "#000000" : "#ffffff";
}

function getThemeContrastProperties(contrast: number): Record<string, string> {
  return {
    "--theme-background-strength": `${4 + contrast * 0.12}%`,
    "--theme-surface-strength": `${6 + contrast * 0.16}%`,
    "--theme-control-strength": `${3 + contrast * 0.08}%`,
    "--theme-accent-strength": `${6 + contrast * 0.2}%`,
    "--theme-border-strength": `${8 + contrast * 0.16}%`,
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
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--theme-accent-seed", colors.accentColor);
  rootStyle.setProperty("--theme-accent-foreground", getThemeAccentForeground(colors.accentColor));
  rootStyle.setProperty("--theme-neutral-seed", colors.neutralColor);
  for (const [property, value] of Object.entries(getThemeContrastProperties(colors.contrast))) {
    rootStyle.setProperty(property, value);
  }
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
