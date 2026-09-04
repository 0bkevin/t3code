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

const isDocumentFocused = (): boolean =>
  typeof document !== "undefined" && typeof document.hasFocus === "function" && document.hasFocus();

type FocusIntent = {
  userFocusedElement: HTMLElement | null;
  pendingFocus: boolean;
  pendingFocusVersion: number;
  automationFocusedElement: HTMLElement | null;
  windowBlurred: boolean;
  windowRefocused: boolean;
};

const trackFocusIntent = (intent: FocusIntent): (() => void) | null => {
  if (typeof document === "undefined") return null;

  const onPointerDown = (event: Event): void => {
    if (!event.isTrusted) return;
    intent.pendingFocus = true;
    intent.userFocusedElement = event.target instanceof HTMLElement ? event.target : null;
    const version = ++intent.pendingFocusVersion;
    queueMicrotask(() => {
      if (intent.pendingFocusVersion !== version || !intent.pendingFocus) return;
      intent.pendingFocus = false;
      intent.userFocusedElement = null;
    });
  };
  const onKeyDown = (event: Event): void => {
    if (!event.isTrusted) return;
    intent.pendingFocus = true;
    intent.userFocusedElement = null;
    const version = ++intent.pendingFocusVersion;
    queueMicrotask(() => {
      if (intent.pendingFocusVersion !== version || !intent.pendingFocus) return;
      intent.pendingFocus = false;
    });
  };
  const onFocusIn = (event: Event): void => {
    const focusedElement = event.target instanceof HTMLElement ? event.target : null;
    const nativeFocus = intent.windowBlurred && intent.windowRefocused;
    intent.pendingFocusVersion += 1;
    intent.userFocusedElement = intent.pendingFocus || !nativeFocus ? focusedElement : null;
    intent.automationFocusedElement = nativeFocus ? focusedElement : null;
    intent.pendingFocus = false;
    intent.windowBlurred = false;
    intent.windowRefocused = false;
  };
  const onWindowBlur = (): void => {
    intent.windowBlurred = true;
    intent.windowRefocused = false;
    intent.userFocusedElement = null;
  };
  const onWindowFocus = (): void => {
    if (intent.windowBlurred) intent.windowRefocused = true;
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("focusin", onFocusIn, true);
  if (typeof window !== "undefined") {
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("focus", onWindowFocus);
  }
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("focusin", onFocusIn, true);
    if (typeof window !== "undefined") {
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("focus", onWindowFocus);
    }
  };
};

let nextFocusTransactionId = 0;
let latestFocusTransactionId = 0;
let focusTransactionTail = Promise.resolve();

const acquireFocusTransaction = async (): Promise<() => void> => {
  const predecessor = focusTransactionTail;
  let release!: () => void;
  focusTransactionTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  return release;
};

/**
 * Keeps preview automation from changing focus in the shared renderer.
 */
export async function withPreviewAutomationFocus<T>(
  operation: () => Promise<T>,
  options?: { readonly shouldRestoreFocus?: (result: T) => boolean },
): Promise<T> {
  const releaseFocusTransaction = await acquireFocusTransaction();

  try {
    const transactionId = ++nextFocusTransactionId;
    latestFocusTransactionId = transactionId;
    const wasDocumentFocused = isDocumentFocused();
    const previouslyFocused = getMeaningfulActiveElement();
    const focusIntent: FocusIntent = {
      userFocusedElement: null,
      pendingFocus: false,
      pendingFocusVersion: 0,
      automationFocusedElement: null,
      windowBlurred: false,
      windowRefocused: false,
    };
    const stopTrackingFocusIntent = trackFocusIntent(focusIntent);

    let operationCompleted = false;
    let operationResult!: T;
    try {
      operationResult = await operation();
      operationCompleted = true;
      return operationResult;
    } finally {
      try {
        stopTrackingFocusIntent?.();
      } catch {
        // Listener cleanup is best effort; never mask the automation result.
      }
      try {
        // A connected active element may represent either automation or a user
        // interaction (including one into the preview). Pointer/keyboard focus
        // events provide the ownership signal available here. Chromium reports
        // programmatic HTMLElement.focus() as trusted focusin too, so an active
        // document focusin without the native window transfer is treated as
        // user-owned; native focus without that transfer remains ambiguous.
        let resultAllowsRestore = true;
        if (operationCompleted && options?.shouldRestoreFocus) {
          try {
            resultAllowsRestore = options.shouldRestoreFocus(operationResult);
          } catch {
            // A result predicate is advisory; never mask the automation result.
          }
        }
        const activeElement = getMeaningfulActiveElement();
        const nativeRestorationConfirmed =
          options?.shouldRestoreFocus !== undefined && resultAllowsRestore;
        const shouldRestoreFocus =
          resultAllowsRestore &&
          transactionId === latestFocusTransactionId &&
          wasDocumentFocused &&
          isDocumentFocused() &&
          previouslyFocused?.isConnected &&
          (!activeElement ||
            ((nativeRestorationConfirmed ||
              activeElement === focusIntent.automationFocusedElement ||
              (focusIntent.windowBlurred && focusIntent.windowRefocused)) &&
              activeElement !== focusIntent.userFocusedElement));
        if (shouldRestoreFocus) {
          try {
            previouslyFocused.focus({ preventScroll: true });
          } catch {
            // Focus restoration is best effort; never mask the automation result.
          }
        }
      } catch {
        // Focus state inspection is best effort; never mask the automation result.
      }
    }
  } finally {
    releaseFocusTransaction();
  }
}
