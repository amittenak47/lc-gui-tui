# Gestures, toolbar palette — 2026-08-13

**Overview:** Android writing-mode gesture lock, then a follow-up: lift the dock so the colour wheel is on-screen and morph the wheel on open/close/palette cycle.

Ink presets were pulled before commit — a new toolbar design is coming.

## Todos

- [x] Android edge Back: fix CSS→view coords, 200dp budget centred on the hand
- [x] Home: sticky immersive nav bar while Pen / Highlighter / Eraser
- [x] Dock lift + colour-wheel viewport clamp
- [x] Morph open/close and palette-cycle on `ColorRadial`


---

## A) Android gesture lock (shipped, needs APK rebuild)

**Symptom:** writing on canvas edges fires Back (left/right) or Home.

**Mechanism:**

1. `getBoundingClientRect` is viewport-relative. Kotlin did `css * dpr - getLocationOnScreen()`, which shoved strips off the WebView. Correct: `screen = css * dpr + viewportLoc`.
2. Android caps exclusions at **200dp/edge**. Full-height strips were clipped to the **top** of the board. Now a 200 CSS-px band, centred, then follows the stylus (`focusY`, 40px hysteresis).
3. Home has no exclusion API. Writing tools hide `navigationBars()` with `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` (first swipe shows chrome, second still leaves). API 33+ consumes Back so a leaked swipe cannot finish the activity.

**Mode:** only `freedraw` / `highlighter` / `eraser`. Reading/select restore bars and clear rects.

**Verify:** rebuild APK (`android:apk`). JS alone does not update Kotlin.

## B) Colour wheel cutoff + morph

**Symptom:** dock sits at `bottom: 10px`. Wheel is `position: fixed`, centred on the swatch, `OUTER_R = 78`. Swatch centre is ~24px above the dock bottom → ~46px of the ring is under the window. Toolbar also paints over the hub.

**Fix:**

- Desktop `.lc-map-controls` bottom clears `radius − half island + air` (`--lc-color-wheel-r`).
- Clamp the portaled wheel into the viewport (floating toolbar / short windows).
- Open/close: keep the portal mounted through a MorphBar-timed scale (do not unmount on close before the out animation).
- Palette cycle: MorphBar between the last two palettes; incoming disc rotates in (next vs prev).

**Deliberate non-changes:** mobile dock already sits above the coach peek (~98px) — leave it. No `PdfDocument.tsx`.
