/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { SidecarChooser, type SidecarChoice } from "./SidecarChooser";
import type { AnnotateDocMeta } from "../util/annotateStore";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function meta(id: string, updatedAt: number, label?: string): AnnotateDocMeta {
  return { id, name: "dp.pdf", hash: "bin-abc", docType: "pdf", updatedAt, ...(label ? { label } : {}) };
}

function mount(matches: AnnotateDocMeta[], onChoose = vi.fn()) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<SidecarChooser docName="dp.pdf" matches={matches} onChoose={onChoose} />);
  });
  const holds = () => Array.from(host.querySelectorAll<HTMLElement>(".lc-hold-choice"));
  return {
    host,
    onChoose,
    holds,
    titles: () => holds().map((hold) => hold.querySelector("strong")?.textContent),
    /** HoldButtons commit on hold; the test fires the confirm the same way. */
    hold: (index: number) => {
      const button = holds()[index];
      act(() => {
        button?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      });
      return button;
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe("SidecarChooser", () => {
  it("lists every set, then the offer to start another", () => {
    const view = mount([meta("mdink-2", 2_000, "Second pass"), meta("mdink-1", 1_000)]);
    const titles = view.titles();
    expect(titles[0]).toBe("Second pass");
    // No label yet, so the fallback names the sitting rather than counting.
    expect(titles[1]).toMatch(/^dp\.pdf — /);
    expect(titles[2]).toBe("New annotation set");
    view.unmount();
  });

  it("says how many sets are competing for the file", () => {
    const view = mount([meta("mdink-1", 1), meta("mdink-2", 2), meta("mdink-3", 3)]);
    expect(view.host.textContent).toContain("3 sets of annotations");
    view.unmount();
  });

  it("names the file in its dialog label, for the reader who cannot see it", () => {
    const view = mount([meta("mdink-1", 1), meta("mdink-2", 2)]);
    expect(view.host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "Annotations for dp.pdf",
    );
    view.unmount();
  });

  it("reports cancel, which is a real answer here", () => {
    // Picking one for the reader is the behaviour this dialog exists to remove,
    // so declining has to be reportable rather than a dismissed modal.
    const onChoose = vi.fn((_choice: SidecarChoice) => {});
    const view = mount([meta("mdink-1", 1), meta("mdink-2", 2)], onChoose);
    act(() => {
      view.host.querySelector<HTMLButtonElement>(".lc-settings-foot button")?.click();
    });
    expect(onChoose).toHaveBeenCalledWith({ kind: "cancel" });
    view.unmount();
  });

  it("cancels on a backdrop press rather than opening something", () => {
    const onChoose = vi.fn((_choice: SidecarChoice) => {});
    const view = mount([meta("mdink-1", 1), meta("mdink-2", 2)], onChoose);
    const backdrop = view.host.querySelector<HTMLElement>(".lc-settings-backdrop");
    act(() => {
      backdrop?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChoose).toHaveBeenCalledWith({ kind: "cancel" });
    view.unmount();
  });

  it("does not cancel when the press was inside the dialog", () => {
    const onChoose = vi.fn((_choice: SidecarChoice) => {});
    const view = mount([meta("mdink-1", 1), meta("mdink-2", 2)], onChoose);
    act(() => {
      view.host
        .querySelector<HTMLElement>(".lc-settings-modal")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChoose).not.toHaveBeenCalled();
    view.unmount();
  });
});
