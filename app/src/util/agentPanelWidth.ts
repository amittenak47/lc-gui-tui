/** Desktop coach column width. Mobile/tablet sheets ignore this. */

const KEY = "whiteboard.agent.panelWidth.v1";

export const AGENT_PANEL_WIDTH_DEFAULT = 520;
export const AGENT_PANEL_WIDTH_MIN = 400;
export const AGENT_PANEL_WIDTH_MAX = 960;
/** Leave at least this many CSS pixels for the document. */
const DOCUMENT_MIN = 480;

export function maxAgentPanelWidth(viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth): number {
  return Math.min(
    AGENT_PANEL_WIDTH_MAX,
    Math.max(AGENT_PANEL_WIDTH_MIN, Math.floor(viewportWidth - DOCUMENT_MIN)),
  );
}

export function clampAgentPanelWidth(
  px: number,
  viewportWidth?: number,
): number {
  const max = maxAgentPanelWidth(viewportWidth);
  if (!Number.isFinite(px)) return AGENT_PANEL_WIDTH_DEFAULT;
  return Math.min(max, Math.max(AGENT_PANEL_WIDTH_MIN, Math.round(px)));
}

export function loadAgentPanelWidth(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return AGENT_PANEL_WIDTH_DEFAULT;
    return clampAgentPanelWidth(Number(raw));
  } catch {
    return AGENT_PANEL_WIDTH_DEFAULT;
  }
}

export function saveAgentPanelWidth(px: number): number {
  const next = clampAgentPanelWidth(px);
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    /* private browsing */
  }
  return next;
}

export function applyAgentPanelWidth(px: number): number {
  const next = clampAgentPanelWidth(px);
  if (typeof document === "undefined") return next;
  document.documentElement.style.setProperty("--lc-agent-width", `${next}px`);
  return next;
}

/** First paint + window shrink must not leave a column wider than the hole. */
export function installAgentPanelWidth(): () => void {
  applyAgentPanelWidth(loadAgentPanelWidth());
  const onResize = () => applyAgentPanelWidth(loadAgentPanelWidth());
  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
}
