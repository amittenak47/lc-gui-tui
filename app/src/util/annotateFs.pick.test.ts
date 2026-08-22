/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FILE_PICKER_GIVE_UP_MS,
  FILE_PICKER_POINTER_MS,
  FILE_PICKER_RESUME_MS,
  pickDocumentFile,
} from "./annotateFs";

function fileInput(): HTMLInputElement {
  const input = document.querySelector("input[type='file']");
  if (!(input instanceof HTMLInputElement)) throw new Error("picker input missing");
  return input;
}

function setFiles(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, "files", {
    configurable: true,
    value: {
      0: file,
      length: 1,
      item: (index: number) => (index === 0 ? file : null),
    },
  });
}

beforeEach(() => {
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.querySelectorAll("input[type='file']").forEach((node) => node.remove());
});

describe("pickDocumentFile dismiss", () => {
  it("resolves null on the cancel event", async () => {
    const pending = pickDocumentFile();
    fileInput().dispatchEvent(new Event("cancel"));
    await expect(pending).resolves.toBeNull();
  });

  it("resolves null after the WebView is focused again without a file", async () => {
    vi.useFakeTimers();
    const pending = pickDocumentFile();
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(FILE_PICKER_RESUME_MS + FILE_PICKER_GIVE_UP_MS);
    await expect(pending).resolves.toBeNull();
  });

  it("resolves null after returning to the foreground without a file", async () => {
    vi.useFakeTimers();
    const pending = pickDocumentFile();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(FILE_PICKER_RESUME_MS + FILE_PICKER_GIVE_UP_MS);
    await expect(pending).resolves.toBeNull();
  });

  it("does not dismiss on focus if the picker never left the foreground", async () => {
    vi.useFakeTimers();
    const pending = pickDocumentFile();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(FILE_PICKER_RESUME_MS + FILE_PICKER_GIVE_UP_MS);
    await Promise.resolve();
    expect(settled).toBe(false);
    fileInput().dispatchEvent(new Event("cancel"));
    await expect(pending).resolves.toBeNull();
  });

  it("opens a PDF whose name has no .pdf extension", async () => {
    const pending = pickDocumentFile();
    const input = fileInput();
    setFiles(input, new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "document"));
    input.dispatchEvent(new Event("change"));
    const opened = await pending;
    expect(opened?.docType).toBe("pdf");
    expect(opened?.bytes?.byteLength).toBe(5);
  });

  it("keeps a real pick that arrives during the resume grace", async () => {
    vi.useFakeTimers();
    const pending = pickDocumentFile();
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    const input = fileInput();
    setFiles(input, new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "a.pdf"));
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(FILE_PICKER_RESUME_MS + FILE_PICKER_GIVE_UP_MS);
    const opened = await pending;
    expect(opened?.name).toBe("a.pdf");
    expect(opened?.docType).toBe("pdf");
    expect(opened?.bytes?.byteLength).toBe(4);
  });

  it("resolves null when the user points at the app after the picker was up", async () => {
    // The pointer only means "back in the app" once the picker has actually
    // taken the foreground — see the case below for why arming before that
    // silently threw away real picks.
    vi.useFakeTimers();
    const pending = pickDocumentFile();
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(FILE_PICKER_POINTER_MS + FILE_PICKER_GIVE_UP_MS);
    await expect(pending).resolves.toBeNull();
  });
});

describe("a tap before the picker appears", () => {
  it("does not cancel the pick", async () => {
    // Android SAF can take a second to cover the WebView. An impatient second
    // tap must not settle the pick as dismissed — the file the reader then
    // chooses would be dropped with no error at all.
    vi.useFakeTimers();
    const pending = pickDocumentFile();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    window.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(FILE_PICKER_POINTER_MS * 4);
    await Promise.resolve();
    expect(settled).toBe(false);

    window.dispatchEvent(new Event("blur"));
    const input = fileInput();
    setFiles(input, new File([new Uint8Array([1, 2, 3])], "book.pdf"));
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toMatchObject({ name: "book.pdf" });
  });

  it("still dismisses on a tap after the picker has been in front", async () => {
    vi.useFakeTimers();
    const pending = pickDocumentFile();
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(FILE_PICKER_POINTER_MS + FILE_PICKER_GIVE_UP_MS);
    await expect(pending).resolves.toBeNull();
  });
});

describe("a file that arrives after the deadline", () => {
  it("is still opened, not discarded", async () => {
    // The bug this poll exists for: Android delivers `change` whenever its
    // content resolver gets round to it. A single-shot deadline saw an empty
    // input, resolved null, and the caller's `if (!picked) return` swallowed
    // the whole open — the reader picked a file and nothing happened at all.
    vi.useFakeTimers();
    const pending = pickDocumentFile();
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));

    // Well past the old 2.5s deadline, but inside the give-up window.
    await vi.advanceTimersByTimeAsync(FILE_PICKER_RESUME_MS * 3);

    const input = fileInput();
    setFiles(input, new File([new Uint8Array([1, 2, 3])], "late.pdf"));
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({ name: "late.pdf" });
  });
});
