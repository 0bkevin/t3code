const getMeaningfulActiveElement = (): HTMLElement | null => {
  if (typeof document === "undefined" || typeof HTMLElement === "undefined") return null;

  const activeElement = document.activeElement;
  if (
    !(activeElement instanceof HTMLElement) ||
    !activeElement.isConnected ||
    activeElement === document.body ||
    activeElement === document.documentElement
  ) {
    return null;
  }
  return activeElement;
};

/**
 * Keeps preview automation from changing focus in the shared renderer.
 */
export async function withPreviewAutomationFocus<T>(operation: () => Promise<T>): Promise<T> {
  const previouslyFocused = getMeaningfulActiveElement();

  try {
    return await operation();
  } finally {
    if (previouslyFocused?.isConnected) {
      try {
        previouslyFocused.focus({ preventScroll: true });
      } catch {
        // Focus restoration is best effort; never mask the automation result.
      }
    }
  }
}
