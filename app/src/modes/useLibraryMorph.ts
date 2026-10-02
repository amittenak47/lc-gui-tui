import { useLayoutEffect, useRef } from "react";
import { animate, type AnimationPlaybackControls } from "motion";

/** Preserve the current form, focus and scroll surface while the menu changes. */
export function useLibraryMorph(view: string) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<number | null>(null);
  const running = useRef<{ height: AnimationPlaybackControls; body?: AnimationPlaybackControls } | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const from = running.current ? node.offsetHeight : previous.current;
    running.current?.height.stop();
    running.current?.body?.stop();
    running.current = null;
    node.style.height = "";
    node.classList.remove("is-morphing");
    const to = node.offsetHeight;
    previous.current = to;
    if (from === null || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    node.classList.add("is-morphing");
    const body = node.querySelector<HTMLElement>(".lc-settings-body");
    const current = {
      height: animate(node, { height: [`${from}px`, `${to}px`] }, { duration: 0.22, ease: [0.22, 1, 0.36, 1] }),
      body: body ? animate(body, { opacity: [0.45, 1], y: [5, 0] }, { duration: 0.18, ease: "easeOut" }) : undefined,
    };
    running.current = current;
    void current.height.then(() => {
      if (running.current !== current) return;
      running.current = null;
      node.style.height = "";
      node.classList.remove("is-morphing");
    });
  }, [view]);
  useLayoutEffect(() => () => {
    running.current?.height.stop();
    running.current?.body?.stop();
    running.current = null;
  }, []);
  return ref;
}
