import { forwardRef, useImperativeHandle } from "react";
import { showNotification } from "../util/notifications";

export const ANNOUNCE_HOLD_MS = 1600;
export interface ModeIndicatorHandle { show(label: string, holdMs?: number): void }
export type ModeIndicatorProps = Record<never, never>;

/** Keep the light imperative Board API; notifications share one header stack. */
export const ModeIndicator = forwardRef<ModeIndicatorHandle, ModeIndicatorProps>(
  function ModeIndicator(_props, ref) {
    useImperativeHandle(ref, () => ({ show: (label, holdMs) => { showNotification(label, holdMs); } }), []);
    return null;
  },
);