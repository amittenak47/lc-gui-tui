import { useLayoutEffect, useRef, type RefObject } from "react";

/** Follow local word-reveal/fold layout without rerendering the transcript.
 * Reading older messages opts out until the user returns to the bottom. */
function rememberScroll(
  positions: Map<string, { top: number; pinned: boolean }>,
  scope: string,
  top: number,
  pinned: boolean,
) {
  positions.set(scope, { top, pinned });
  if (positions.size > 100) positions.delete(positions.keys().next().value!);
}

export function useChatFollow(
  list: RefObject<HTMLDivElement | null>,
  scope: string,
  open: boolean,
  hold?: RefObject<boolean>,
  memory?: Map<string, { top: number; pinned: boolean }>,
  onChange?: () => void,
) {
  const pinned = useRef(true);
  const fallback = useRef(new Map<string, { top: number; pinned: boolean }>());
  const positions = memory ?? fallback.current;
  const scopeRef = useRef(scope);
  /** Ignore scroll events while React is swapping the transcript under this node. */
  const acceptScroll = useRef(true);
  // Cleanup runs after the next session's messages are already in the DOM, so
  // scrollTop there belongs to the wrong conversation. Read it while this
  // render still shows the scope we are leaving.
  if (scopeRef.current !== scope) {
    const node = list.current;
    if (node) rememberScroll(positions, scopeRef.current, node.scrollTop, pinned.current);
    scopeRef.current = scope;
    acceptScroll.current = false;
  }
  useLayoutEffect(() => {
    const node = list.current;
    if (!node || !open) return;
    const saved = positions.get(scope);
    pinned.current = saved?.pinned ?? true;
    // Content may not be tall enough on the first frame after reload. Keep
    // putting the offset back until the transcript can hold it.
    const placeSaved = () => {
      const place = positions.get(scope);
      if (!place || place.pinned || pinned.current) return;
      const max = node.scrollHeight - node.clientHeight;
      if (Math.abs(node.scrollTop - place.top) <= 1) return;
      // Still short of the saved offset. Assigning now would clamp and look like a new scroll.
      if (max > 0 && max + 1 < place.top) return;
      acceptScroll.current = false;
      node.scrollTop = place.top;
      acceptScroll.current = true;
    };
    placeSaved();
    let raf = 0;
    const follow = () => {
      if (!pinned.current || hold?.current || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (pinned.current) node.scrollTop = node.scrollHeight;
      });
    };
    const onScroll = () => {
      if (!acceptScroll.current) return;
      // A zero-height frame while the transcript swaps must not pin a restored offset.
      if (node.scrollHeight - node.clientHeight <= 0) return;
      pinned.current = node.scrollHeight - node.clientHeight - node.scrollTop < 32;
      rememberScroll(positions, scope, node.scrollTop, pinned.current);
      onChange?.();
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    acceptScroll.current = true;
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => { placeSaved(); follow(); }) : null;
    const watch = () => {
      resize?.disconnect();
      for (const child of node.children) resize?.observe(child);
      placeSaved();
      follow();
    };
    const mutation = new MutationObserver(watch);
    mutation.observe(node, { childList: true });
    watch();
    return () => {
      if (acceptScroll.current) {
        rememberScroll(positions, scope, node.scrollTop, pinned.current);
        onChange?.();
      }
      cancelAnimationFrame(raf); resize?.disconnect(); mutation.disconnect(); node.removeEventListener("scroll", onScroll);
    };
  }, [list, scope, open, memory, onChange]);
  return pinned;
}
