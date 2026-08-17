/**
 * Library-row trash: first delete in a while is hold + ConfirmDialog.
 * After that succeeds, a tap on the bin is enough until the window lapses.
 */

import { useEffect, useState } from "react";

/** How long tap-to-delete stays armed after a confirmed hold-delete. */
export const LIBRARY_DELETE_ARM_MS = 90_000;

let armedUntil = 0;

export function isLibraryDeleteArmed(now = Date.now()): boolean {
  return now < armedUntil;
}

export function armLibraryDelete(now = Date.now()): void {
  armedUntil = now + LIBRARY_DELETE_ARM_MS;
}

export function libraryDeleteArmRemaining(now = Date.now()): number {
  return Math.max(0, armedUntil - now);
}

/** Vitest only. */
export function resetLibraryDeleteArmForTests(): void {
  armedUntil = 0;
}

export function useLibraryDeleteArm(): {
  tapArmed: boolean;
  arm: () => void;
} {
  const [tapArmed, setTapArmed] = useState(() => isLibraryDeleteArmed());

  useEffect(() => {
    if (!tapArmed) return;
    const wait = libraryDeleteArmRemaining();
    if (wait === 0) {
      setTapArmed(false);
      return;
    }
    const timer = window.setTimeout(() => setTapArmed(false), wait);
    return () => window.clearTimeout(timer);
  }, [tapArmed]);

  const arm = () => {
    armLibraryDelete();
    setTapArmed(true);
  };

  return { tapArmed, arm };
}
