/** @vitest-environment jsdom */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../util/artifactRepository", () => ({
  ARTIFACTS_CHANGED: "lc-artifacts-changed",
  readArtifact: () => Promise.resolve({ item: { title: "Plan.md" }, snapshot: { kind: "markdown", value: { source: "" } } }),
}));

import { AgentSidePanel, type AgentChatMessage } from "./AgentSidePanel";

vi.mock("../util/mobile", () => ({ useIsMobile: () => false }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.textContent = "";
  vi.unstubAllGlobals();
});

const user: AgentChatMessage = { id: "u1", role: "user", content: "test", at: 1 };
const agent: AgentChatMessage = { id: "a1", role: "assistant", content: "Here is a plan.", at: 2 };
const pending: AgentChatMessage = {
  id: "p1", role: "assistant", content: "", at: 3, pending: true,
  pendingAck: { flags: ["Ask"], hasQuestion: true, boardAttached: false, photoCount: 0 },
};

function mount(props: Partial<ComponentProps<typeof AgentSidePanel>> = {}) {
  const save = vi.fn();
  const manage = vi.fn();
  act(() => root.render(
    <AgentSidePanel
      open
      mode="review"
      onModeChange={() => {}}
      busy={false}
      messages={[user, agent, pending]}
      onSend={() => {}}
      onSaveArtifact={save}
      onManageArtifacts={manage}
      {...props}
    />,
  ));
  return { save, manage };
}

function button(label: string) {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

it("uses save and paperclip icons on the AGENT/YOU row instead of labeled pills", () => {
  mount();
  expect(button("Save note")).toBeTruthy();
  expect(button("Save answer")).toBeTruthy();
  expect(document.querySelectorAll('button[aria-label="Attachments"]')).toHaveLength(2);
  expect([...document.querySelectorAll("button")].some((node) => node.textContent === "Save answer")).toBe(false);
  expect([...document.querySelectorAll("button")].some((node) => node.textContent === "Attachments")).toBe(false);
  expect(host.querySelector(".lc-agent-turn-user .lc-agent-turn-head .lc-agent-turn-tools")).toBeTruthy();
  expect(host.querySelector(".lc-agent-turn-assistant .lc-agent-turn-head .lc-agent-turn-tools")).toBeTruthy();
  expect(host.querySelector('[data-coach-message="p1"] .lc-agent-turn-tools')).toBeNull();
});

it("saves the user note and agent answer from the header icons", () => {
  const { save } = mount();
  act(() => button("Save note")!.click());
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: "u1" }), {
    kind: "markdown", title: "Note.md", source: "test",
  });
  act(() => button("Save answer")!.click());
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), {
    kind: "markdown", title: "Answer.md", source: "Here is a plan.",
  });
});

it("opens the catalog from C and from a message paperclip", () => {
  const { manage } = mount();
  const catalog = button("Whiteboards and files");
  expect(catalog).toBeTruthy();
  expect(catalog!.textContent).toBe("C");
  const mid = host.querySelector(".lc-agent-composer-mid")!;
  expect(mid.querySelector('[aria-label="Annotations"]')).toBeTruthy();
  expect(mid.textContent).toContain("C");
  expect(host.textContent).not.toContain("Whiteboards & files");
  act(() => catalog!.click());
  expect(manage).toHaveBeenCalledWith();
  const clips = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Attachments"]')];
  act(() => clips[0]!.click());
  expect(manage).toHaveBeenCalledWith(expect.objectContaining({ id: "u1" }));
});

it("keeps named Save buttons only for agent-created proposals", () => {
  const { save } = mount({
    messages: [{
      ...agent,
      artifactProposals: [{ kind: "code", title: "solution.py", source: "print(1)" }],
    }],
  });
  const proposal = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "Save solution.py");
  expect(proposal).toBeTruthy();
  act(() => proposal!.click());
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), expect.objectContaining({ title: "solution.py" }), 0);
});

it("still uses a Tests bubble for harness output", () => {
  mount({
    messages: [{ id: "t1", role: "app", content: "3 passed, 1 failed", at: 4 }],
  });
  expect(host.querySelector(".lc-agent-turn-app")).toBeTruthy();
  expect(host.querySelector(".lc-agent-turn-role")?.textContent).toBe("Tests");
  expect(host.querySelector(".lc-artifact-save-notice")).toBeNull();
});

it("renders saved attachments as a text span, not a Tests bubble", async () => {
  const reference = {
    parent: { kind: "annotate" as const, id: "d1" },
    artifactId: "n1",
    kind: "markdown" as const,
  };
  mount({
    messages: [{
      id: "s1",
      role: "app",
      content: "Saved attachment",
      at: 4,
      artifacts: [reference],
    }],
    onOpenArtifact: vi.fn(),
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(host.querySelector(".lc-agent-turn-app")).toBeNull();
  expect(host.querySelector(".lc-agent-turn-role")).toBeNull();
  expect(host.querySelector(".lc-artifact-save-notice")).toBeTruthy();
  expect(host.querySelector(".lc-artifact-line.is-ok")).toBeTruthy();
  expect(host.querySelector(".lc-artifact-save-notice")?.textContent).toContain("'Plan.md' saved");
  expect(host.querySelector('[data-coach-message="s1"]')?.tagName).toBe("SPAN");
});

it("puts the reply count under the thread peek without a chevron", () => {
  mount({
    messages: [
      user,
      { id: "r1", role: "user", content: "I know, I want to see the code", at: 3,
        replyTo: { id: "u1", role: "user", excerpt: "test" } },
    ],
  });
  const chip = host.querySelector(".lc-agent-thread-open") as HTMLButtonElement;
  expect(chip).toBeTruthy();
  expect(chip.querySelector(".lc-agent-thread-open-chevron")).toBeNull();
  expect(chip.textContent).not.toContain("›");
  const peek = chip.querySelector(".lc-agent-thread-open-peek")!;
  const count = chip.querySelector(".lc-agent-thread-open-count")!;
  expect(peek.textContent).toContain("I know");
  expect(count.textContent).toMatch(/1 reply/);
  expect(Boolean(peek.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
});
