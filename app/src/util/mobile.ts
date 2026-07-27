/**
 * One definition of "this is a phone or a tablet", shared by the layout and the
 * CSS.
 *
 * Width alone is wrong (a narrow desktop window is still a desktop) and a
 * coarse pointer alone is wrong (a 27" touchscreen is still a desktop), so the
 * rule is: narrow, **or** coarse-pointered and not very wide. The same query
 * string is what `lc-mobile` on the app root means, so styles and behaviour can
 * never disagree.
 */

import { useEffect, useState } from "react";

export const MOBILE_MEDIA_QUERY =
  "(max-width: 900px), (pointer: coarse) and (max-width: 1280px)";

export function isMobileViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

/** Re-renders when the viewport crosses the mobile threshold. */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(isMobileViewport);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = () => setMobile(query.matches);
    onChange();
    // Safari < 14 only has the deprecated listener API.
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }
    query.addListener(onChange);
    return () => query.removeListener(onChange);
  }, []);

  return mobile;
}
