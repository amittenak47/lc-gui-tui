/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ArtifactRef } from "../util/padArtifacts";

const repo = vi.hoisted(() => ({
  readArtifact: vi.fn(),
}));

vi.mock("../util/artifactRepository", () => ({
  ARTIFACTS_CHANGED: "lc-artifacts-changed",
  readArtifact: (...args: unknown[]) => repo.readArtifact(...args),
}));

import { ArtifactCards } from "./ArtifactCards";

const reference: ArtifactRef = {
  parent: { kind: "whiteboard", id: "nb1" },
  artifactId: "n1",
  kind: "markdown",
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  repo.readArtifact.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.textContent = "";
  vi.unstubAllGlobals();
});

async function mount(refs: ArtifactRef[] = [reference], onOpen = vi.fn()) {
  await act(async () => {
    root.render(<ArtifactCards references={refs} onOpen={onOpen} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return onOpen;
}

it("renders a one-line kind icon and saved, not a preview card", async () => {
  repo.readArtifact.mockResolvedValue({ item: { title: "Plan.md" }, snapshot: { kind: "markdown", value: { source: "# hi" } } });
  await mount();
  expect(host.textContent).toMatch(/^\s*'Plan.md' saved\s*$/);
  expect(host.textContent).not.toContain("markdown attachment");
  expect(host.textContent).not.toContain("Tap to open");
  expect(host.querySelector(".lc-artifact-line.is-ok")).toBeTruthy();
  expect(host.querySelector(".lc-artifact-card")).toBeNull();
  expect(host.querySelector("canvas")).toBeNull();
  expect(host.querySelector("pre")).toBeNull();
  expect(host.querySelector('button[aria-label="Open note"] svg')).toBeTruthy();
});

it("turns the line red with a fail icon and error tooltip", async () => {
  repo.readArtifact.mockRejectedValue(new Error("This attachment is in Trash. Restore it from Attachments."));
  const onOpen = await mount();
  const line = host.querySelector(".lc-artifact-line.is-bad");
  expect(line).toBeTruthy();
  expect(line!.textContent).toContain("saved");
  const tip = host.querySelector("[data-tip]") as HTMLElement;
  expect(tip.getAttribute("data-tip")).toBe("This attachment is in Trash. Restore it from Attachments.");
  const icon = host.querySelector<HTMLButtonElement>('button[aria-label="Note attachment error"]');
  expect(icon).toBeTruthy();
  act(() => icon!.click());
  expect(onOpen).toHaveBeenCalledWith(reference);
});
