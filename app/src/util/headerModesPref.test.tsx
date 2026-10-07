/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { HEADER_MODES, loadHeaderModes, saveHeaderModes, useHeaderModes } from "./headerModesPref";

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
it("defaults every shortcut to visible and preserves unspecified modes in older settings", () => {
  expect(Object.values(loadHeaderModes())).toEqual(HEADER_MODES.map(() => true));
  localStorage.setItem("whiteboard.headerModes.v1", '{"web":false,"explore":false}');
  expect(loadHeaderModes()).toEqual({ annotate:true,whiteboard:true,practice:true,web:false,explore:false });
  localStorage.setItem("whiteboard.headerModes.v1", "malformed");
  expect(Object.values(loadHeaderModes())).toEqual(HEADER_MODES.map(() => true));
});
it("updates mounted headers after saving and after a different window changes settings", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"), root = createRoot(host);
  function Header() { const modes = useHeaderModes(); return <>{HEADER_MODES.filter(([mode]) => modes[mode]).map(([,label]) => label).join(",")}</>; }
  try {
    await act(async () => root.render(<Header />));
    act(() => saveHeaderModes({ ...loadHeaderModes(), web:false, explore:false }));
    expect(host.textContent).toBe("Annotate,Whiteboard,Practice");
    expect(loadHeaderModes().explore).toBe(false);
    localStorage.removeItem("whiteboard.headerModes.v1");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key:"whiteboard.headerModes.v1" })));
    expect(host.textContent).toBe("Annotate,Whiteboard,Practice,Web,Explore");
  } finally { act(() => root.unmount()); }
});
