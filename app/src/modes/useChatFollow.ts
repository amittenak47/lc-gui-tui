import { useLayoutEffect, useRef, type RefObject } from "react";

/** Follow local word-reveal/fold layout without rerendering the transcript.
 * Reading older messages opts out until the user returns to the bottom. */
export function useChatFollow(
  list: RefObject<HTMLDivElement | null>,
  scope: string,
  open: boolean,
  hold?: RefObject<boolean>,
) {
  const pinned = useRef(true);
  const positions = useRef(new Map<string, { top: number; pinned: boolean }>());
  useLayoutEffect(() => {
    const node = list.current;
    if (!node || !open) return;
    const saved = positions.current.get(scope);
    pinned.current = saved?.pinned ?? true;
    if (saved && !saved.pinned) node.scrollTop = saved.top;
    let raf = 0;
    const follow = () => {
      if (!pinned.current || hold?.current || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (pinned.current) node.scrollTop = node.scrollHeight;
      });
    };
    const onScroll = () => { pinned.current = node.scrollHeight - node.clientHeight - node.scrollTop < 32; };
    node.addEventListener("scroll", onScroll, { passive: true });
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(follow) : null;
    const watch = () => {
      resize?.disconnect();
      for (const child of node.children) resize?.observe(child);
      follow();
    };
    const mutation = new MutationObserver(watch);
    mutation.observe(node, { childList: true });
    watch();
    return () => {
      positions.current.set(scope, { top: node.scrollTop, pinned: pinned.current });
      if (positions.current.size > 100) positions.current.delete(positions.current.keys().next().value!);
      cancelAnimationFrame(raf); resize?.disconnect(); mutation.disconnect(); node.removeEventListener("scroll", onScroll);
    };
  }, [list, scope, open]);
  return pinned;
}
