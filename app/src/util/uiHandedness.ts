/** App chrome hand is independent of the writing/ink hand. */
export type UiHandedness = "right" | "left";
const KEY = "whiteboard.uiHandedness";
export function loadUiHandedness(): UiHandedness {
  try { return localStorage.getItem(KEY) === "left" ? "left" : "right"; } catch { return "right"; }
}
export function saveUiHandedness(value: UiHandedness): void {
  const hand = value === "left" ? "left" : "right";
  try { localStorage.setItem(KEY, hand); } catch { /* storage unavailable */ }
  applyUiHandednessAttr(hand);
  window.dispatchEvent(new CustomEvent("lc-ui-handedness", { detail: hand }));
}
export function applyUiHandednessAttr(value: UiHandedness): void {
  if (value === "left") document.documentElement.setAttribute("data-ui-handedness", "left");
  else document.documentElement.removeAttribute("data-ui-handedness");
}
export function installUiHandednessAttr(): () => void {
  const refresh = () => applyUiHandednessAttr(loadUiHandedness());
  refresh();
  window.addEventListener("lc-ui-handedness", refresh);
  window.addEventListener("storage", refresh);
  return () => { window.removeEventListener("lc-ui-handedness", refresh); window.removeEventListener("storage", refresh); };
}
