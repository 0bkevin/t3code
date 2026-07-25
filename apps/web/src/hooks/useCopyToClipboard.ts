import * as React from "react";
import * as Schema from "effect/Schema";

export class ClipboardApiUnavailableError extends Schema.TaggedErrorClass<ClipboardApiUnavailableError>()(
  "ClipboardApiUnavailableError",
  {
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Clipboard API is unavailable while copying ${this.target}.`;
  }
}

export class ClipboardWriteError extends Schema.TaggedErrorClass<ClipboardWriteError>()(
  "ClipboardWriteError",
  {
    target: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to copy ${this.target} to the clipboard.`;
  }
}

/**
 * Copy via the legacy `document.execCommand` path.
 *
 * `navigator.clipboard` only exists in a secure context, so it is undefined
 * over plain http — which is exactly how T3 is reached on a LAN or Tailscale
 * host. Without this fallback every copy button on such an origin silently
 * does nothing, including the ones handing over a pairing command the user
 * cannot reasonably retype.
 */
function writeTextWithExecCommand(value: string): boolean {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  // Keep it off-screen and non-interactive, but still focusable: a hidden or
  // display:none element cannot be selected, which is what execCommand needs.
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";
  const previouslyFocused = document.activeElement;
  document.body.appendChild(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    // Duck-typed rather than `instanceof HTMLElement`: the global is absent in
    // non-DOM environments, where a bare reference throws instead of being
    // falsy — and losing focus is never worth failing a copy over.
    const restoreFocus = (previouslyFocused as unknown as { focus?: unknown } | null)?.focus;
    if (typeof restoreFocus === "function") {
      restoreFocus.call(previouslyFocused);
    }
  }
}

export async function writeTextToClipboard(value: string, target = "text") {
  const hasClipboardApi = typeof navigator !== "undefined" && !!navigator.clipboard?.writeText;
  // `document` is only needed for the legacy fallback, so it is not required
  // when the async Clipboard API is present.
  if (typeof window === "undefined" || (!hasClipboardApi && typeof document === "undefined")) {
    throw new ClipboardApiUnavailableError({
      target,
    });
  }

  if (!value) return false;

  if (hasClipboardApi) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (cause) {
      // A rejected write (permissions policy, no user activation) can still
      // succeed through the legacy path, so fall through rather than fail.
      if (writeTextWithExecCommand(value)) return true;
      throw new ClipboardWriteError({
        target,
        cause,
      });
    }
  }

  if (writeTextWithExecCommand(value)) return true;
  throw new ClipboardApiUnavailableError({
    target,
  });
}

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  target = "text",
  onCopy,
  onError,
}: {
  timeout?: number;
  target?: string;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
} = {}): { copyToClipboard: (value: string, ctx: TContext) => void; isCopied: boolean } {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<NodeJS.Timeout | null>(null);
  const onCopyRef = React.useRef(onCopy);
  const onErrorRef = React.useRef(onError);
  const targetRef = React.useRef(target);
  const timeoutRef = React.useRef(timeout);

  onCopyRef.current = onCopy;
  onErrorRef.current = onError;
  targetRef.current = target;
  timeoutRef.current = timeout;

  const copyToClipboard = React.useCallback((value: string, ctx: TContext): void => {
    void writeTextToClipboard(value, targetRef.current).then(
      (didCopy) => {
        if (!didCopy) return;
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
        setIsCopied(true);

        onCopyRef.current?.(ctx);

        if (timeoutRef.current !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeoutRef.current);
        }
      },
      (error) => {
        console.error(error);
        onErrorRef.current?.(error, ctx);
      },
    );
  }, []);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}
