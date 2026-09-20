import { useLayoutEffect, useRef, type RefObject } from "react";

/** Follow local word-reveal/fold layout without rerendering the transcript.
 * Reading older messages opts out until the user returns to the bottom. */
export function useChatFollow(list: RefObject<HTMLDivElement | null>, scope: string, open: boolean) {
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const node = list.current;
    if (!node || !open) return;
    pinned.current = true;
    let raf = 0;
    const follow = () => {
      if (!pinned.current || raf) return;
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
    return () => { cancelAnimationFrame(raf); resize?.disconnect(); mutation.disconnect(); node.removeEventListener("scroll", onScroll); };
  }, [list, scope, open]);
  return pinned;
}
