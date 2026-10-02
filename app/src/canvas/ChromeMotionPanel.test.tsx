/** @vitest-environment jsdom */
import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChromeMotionPanel } from "./ChromeMotionPanel";

vi.mock("motion/react", async importOriginal => ({
  ...await importOriginal<typeof import("motion/react")>(), useReducedMotion: () => true,
}));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = (open: boolean) => act(() => root.render(
  <ChromeMotionPanel className="tray" open={open}>
    <div data-lc-explore-chrome />
    <button>Annotation</button>
  </ChromeMotionPanel>,
));

it("keeps the Explore portal attached while a sleeping tray is inaccessible", () => {
  render(true);
  const panel = host.querySelector(".tray")!;
  const slot = panel.querySelector("[data-lc-explore-chrome]")!;
  const portalRoot = createRoot(document.createElement("div"));
  act(() => portalRoot.render(createPortal(<button>Search</button>, slot)));
  render(false);
  expect(panel.hasAttribute("inert")).toBe(true);
  expect(panel.getAttribute("aria-hidden")).toBe("true");
  expect(panel.querySelector("[data-lc-explore-chrome]")).toBe(slot);
  expect(slot.textContent).toBe("Search");
  render(true);
  expect(panel.hasAttribute("inert")).toBe(false);
  expect(panel.hasAttribute("aria-hidden")).toBe(false);
  expect(slot.textContent).toBe("Search");
  act(() => portalRoot.unmount());
});

it("folds menu contents independently of the accessible fold button", () => {
  const menu = (open: boolean) => act(() => root.render(<div>
    <button>Expand menu</button>
    <ChromeMotionPanel className="menu" open={open}><button>Recentre</button></ChromeMotionPanel>
  </div>));
  menu(true);
  const recentre = host.querySelector(".menu button");
  menu(false);
  expect(host.querySelector(".menu")?.hasAttribute("inert")).toBe(true);
  expect(host.querySelector("div")?.hasAttribute("inert")).toBe(false);
  menu(true);
  expect(host.querySelector(".menu button")).toBe(recentre);
  expect(host.querySelector(".menu")?.hasAttribute("inert")).toBe(false);
});
