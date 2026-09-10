/** @vitest-environment jsdom */
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneSelectionOverlay, type SceneSelectionOverlayHandle } from "./SceneSelectionOverlay";
import type { PaintSceneElement } from "./paintScene";

vi.mock("../components/MorphBar", () => ({ MorphBar: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

let root: Root;
let host: HTMLDivElement;
let members: PaintSceneElement[];
let changes: Array<{ next: PaintSceneElement[]; commit: boolean; previous?: PaintSceneElement[] }>;
let ref: ReturnType<typeof createRef<SceneSelectionOverlayHandle>>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  ref = createRef<SceneSelectionOverlayHandle>();
  members = [{ id: "box", type: "rectangle", x: 50, y: 100, width: 100, height: 50 }];
  changes = [];
  await act(async () => root.render(<SceneSelectionOverlay ref={ref} getMembers={() => members}
    getViewport={() => ({ scrollX: 0, scrollY: 0, offsetLeft: 0, offsetTop: 0, zoom: 1, width: 400, height: 400 })}
    clientToScene={(x, y) => ({ x, y })}
    onChange={(next, commit, previous) => { changes.push({ next, commit, previous }); members = next; ref.current?.redraw(); }}
    onFlip={() => {}} onDelete={() => {}} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function pointer(label: string, type: string, x: number, y: number) {
  const target = host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
  target.setPointerCapture = () => {};
  await act(async () => target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })));
}

describe("shape selection interactions", () => {
  it("commits the original geometry as the undo baseline", async () => {
    await pointer("Scale se", "pointerdown", 150, 150);
    await pointer("Scale se", "pointermove", 250, 180);
    await pointer("Scale se", "pointerup", 250, 180);
    expect(members[0]).toMatchObject({ width: 200, height: 80 });
    expect(changes.at(-1)).toMatchObject({ commit: true, previous: [{ id: "box", width: 100, height: 50 }] });
  });
  it("restores the starting shape on pointer cancellation without committing", async () => {
    await pointer("Scale se", "pointerdown", 150, 150);
    await pointer("Scale se", "pointermove", 250, 180);
    await pointer("Scale se", "pointercancel", 250, 180);
    expect(members[0]).toMatchObject({ width: 100, height: 50 });
    expect(changes.every((change) => !change.commit)).toBe(true);
  });
  it("lets touch users keep proportions with the dock toggle", async () => {
    await act(async () => (host.querySelector('[aria-label="Keep proportions"]') as HTMLButtonElement).click());
    await pointer("Scale se", "pointerdown", 150, 150);
    await pointer("Scale se", "pointermove", 250, 180);
    expect(members[0].width! / members[0].height!).toBeCloseTo(2);
  });
  it("inserts and drags a bend in one gesture", async () => {
    members = [{ id: "arrow", type: "arrow", x: 50, y: 100, points: [[0, 0], [100, 0]] }];
    await act(async () => ref.current?.redraw());
    await pointer("Add bend", "pointerdown", 100, 100);
    await pointer("Add bend", "pointermove", 100, 60);
    await pointer("Add bend", "pointerup", 100, 60);
    expect(members[0].points).toEqual([[0, 0], [50, -40], [100, 0]]);
    expect(members[0].roundness).toBeTruthy();
    expect(changes.at(-1)?.previous?.[0].points).toHaveLength(2);
  });
});
