/**
 * Corner style for the app's chrome: blocky (2px) or rounded.
 *
 * Blocky chrome reads one radius, `--lc-r-block`, and blocky dialogs one
 * shape; `data-corners="rounded"` on the root swaps both (styles.css,
 * dialogFrame.css). Edges and shadows keep their blocky weight.
 */
export type UiCorners = "blocky" | "rounded";
const KEY = "whiteboard.uiCorners";
export function loadUiCorners(): UiCorners {
  try { return localStorage.getItem(KEY) === "rounded" ? "rounded" : "blocky"; } catch { return "blocky"; }
}
export function saveUiCorners(value: UiCorners): void {
  const corners = value === "rounded" ? "rounded" : "blocky";
  try { localStorage.setItem(KEY, corners); } catch { /* storage unavailable */ }
  applyUiCornersAttr(corners);
  window.dispatchEvent(new CustomEvent("lc-ui-corners", { detail: corners }));
}
export function applyUiCornersAttr(value: UiCorners): void {
  if (value === "rounded") document.documentElement.setAttribute("data-corners", "rounded");
  else document.documentElement.removeAttribute("data-corners");
}
export function installUiCornersAttr(): () => void {
  const refresh = () => applyUiCornersAttr(loadUiCorners());
  refresh();
  window.addEventListener("lc-ui-corners", refresh);
  window.addEventListener("storage", refresh);
  return () => { window.removeEventListener("lc-ui-corners", refresh); window.removeEventListener("storage", refresh); };
}
