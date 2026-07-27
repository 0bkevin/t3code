import { useEffect, useState } from "react";

export const STARTUP_OPTIONAL_UI_DELAY_MS = 2_500;

/**
 * Lets the first usable shell paint before optional runtime UI starts loading.
 */
export function useAfterFirstPaint(delayMs = 0): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let timeout: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      if (delayMs <= 0) {
        setReady(true);
      } else {
        timeout = window.setTimeout(() => setReady(true), delayMs);
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [delayMs]);

  return ready;
}
