/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";
import { HOLD_MS } from "../util/gesture";

afterEach(() => vi.unstubAllGlobals());

it("keeps Delete behind a completed hold, preserves cancellation and blocks input while pending", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"), root = createRoot(host);
  const onConfirm = vi.fn(), onCancel = vi.fn();
  const render = (pending = false) => act(() => root.render(<ConfirmDialog title="Confirm deleting file" message="Book.pdf" confirmLabel="Delete" pending={pending} onConfirm={onConfirm} onCancel={onCancel} />));
  try {
    render();
    expect(host.querySelector('[role="dialog"]')?.getAttribute("data-dialog-shape")).toBe("blocky");
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="Hold to confirm: Delete"]')!;
    act(() => remove.click());
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => { remove.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await act(async () => { remove.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })); });
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => { remove.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, HOLD_MS + 50)); });
    await act(async () => { remove.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true })); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    render(true);
    expect([...host.querySelectorAll('button')].every(button => button.disabled)).toBe(true);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onCancel).not.toHaveBeenCalled();
    render();
    act(() => host.querySelector<HTMLButtonElement>('.lc-secondary')!.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  } finally { act(() => root.unmount()); }
});

it("suppresses the Android long-press menu on buttons without blocking text input menus", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"), root = createRoot(host);
  const onCancel = vi.fn();
  try {
    act(() => root.render(<ConfirmDialog title="Delete?" message="Example" confirmLabel="Delete" onConfirm={() => {}} onCancel={onCancel} />));
    const cancel = host.querySelector<HTMLButtonElement>('.lc-secondary')!;
    const nativeMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => cancel.dispatchEvent(nativeMenu));
    expect(nativeMenu.defaultPrevented).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
    const input = document.createElement("input");
    host.querySelector('.lc-dialog-body')!.append(input);
    const textMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => input.dispatchEvent(textMenu));
    expect(textMenu.defaultPrevented).toBe(false);
    act(() => cancel.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  } finally { act(() => root.unmount()); }
});


it("runs an ordinary button on long-press release when Android does not emit click", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host=document.createElement("div"),root=createRoot(host),onCancel=vi.fn();
  const clock=vi.spyOn(performance,"now");
  try {
    act(()=>root.render(<ConfirmDialog title="Delete?" message="Example" confirmLabel="Delete" onConfirm={()=>{}} onCancel={onCancel}/>));
    const cancel=host.querySelector<HTMLButtonElement>('.lc-secondary')!;
    clock.mockReturnValue(100);
    act(()=>cancel.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,button:0})));
    clock.mockReturnValue(1200);
    act(()=>cancel.dispatchEvent(new MouseEvent("pointerup",{bubbles:true,button:0})));
    expect(onCancel).toHaveBeenCalledTimes(1);
    // Releasing outside the button must leave the dialog open.
    clock.mockReturnValue(2000);
    act(()=>cancel.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,button:0})));
    clock.mockReturnValue(3100);
    act(()=>cancel.dispatchEvent(new MouseEvent("pointerup",{bubbles:true,button:0,clientX:100})));
    expect(onCancel).toHaveBeenCalledTimes(1);
  } finally {act(()=>root.unmount());clock.mockRestore();}
});
