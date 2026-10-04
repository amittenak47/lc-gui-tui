import { usePadHubStatus } from "../util/padHubStatus";

/** The shared desktop hub's reachability, separate from a pad's sync state. */
export function HubStatusDot() {
  const { hub, status } = usePadHubStatus();
  if (!hub || status === "unknown") return null;
  const label = `Desktop hub ${status}`;
  return (
    <span
      className="lc-agent-live-dot lc-hub-status-dot"
      data-status={status}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
