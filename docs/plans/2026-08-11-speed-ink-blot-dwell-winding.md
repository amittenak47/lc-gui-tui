# Speed ink blot, dwell, winding — mechanisms and fix

**Overview:** How speed ink, blot discs, ribbons, dwell, smoothing, and winding interact; then fix dwell+disc fighting, grow the dwell blot over time from a small opaque core outward (fade only at the expanding rim), fill ribbons as per-quads so self-overlap no longer punches holes, and retune the blot-blend dial—while keeping speed width/alpha pooling.

## Todos

- [x] Mechanisms documented (this file)
- [x] Per-quad `fillInkRibbon` (`source-over`); `ribbonSides` unchanged
- [x] Dwell blot **grows over time**: small black core → expand outward; soft fade only at current rim
- [x] Join discs (moving stroke): solid core + annular rim fade at **current** nib radius (not watercolor wash of final size)
- [x] Dwell / near-stationary paint disc-primary; avoid ribbon self-wind fighting the blot
- [x] Retune blot-blend dial (growth rate / rim softness); update Settings hint
- [x] Tests for growth, per-quad, dwell disc-primary

---

## A) How the mechanisms work today

### 1. Speed ink (pace → width / alpha)

- Each sample stores **slowness** (0 = fast, 1 = stopped).
- `inkSpeedWidthGain` / `inkSpeedAlphaGain` in `app/src/canvas/rasterInk.ts` scale tip width and deposit alpha from that slowness × the Speed ink dial.
- Slow / dwell → thicker, darker; flick → thinner, lighter. This is independent of blot discs and ribbons.

### 2. Capture, dwell injection, smooth

- Pointer moves append samples; with Speed ink on, a **dwell timer** (~32 ms) in `app/src/canvas/RasterInkLayer.tsx` keeps appending near-stationary points with rising slowness while the tip is still.
- **Smooth** (`smoothInkPoints` / `simplifyModulatedInkPoints`) reshapes or thins the polyline (live and/or on lift). Fewer points → longer ribbon facets (“spokes”).

### 3. Speed-ink paint path (ribbon + discs)

When `speedInk > 0`, draw goes through `drawRibbonStrokeFrom` in `rasterInk.ts`:

1. Build per-point width/alpha styles.
2. If path is tiny → **short-path**: only `paintInkDisc`.
3. Else alpha buckets → `ribbonSides` + one closed `fillInkRibbon` (nonzero winding) + curvature join discs.

### 4. Blot blend disc today — “watercolor wash”

What you see now is **not** a pool that grows. On each paint, `paintInkDisc` assumes the **final disc radius is already known** and fills that whole circle with a soft radial from the center (and oversized past the nib). That reads like watercolor that has already soaked a fixed circle — a grey cloud — not like ink starting small and spreading.

### 5. Dwell: ribbon winding fights that wash

While holding, dwell keeps adding samples. Paint often leaves the short-path disc and builds a self-intersecting **ribbon** (winding holes / spokes) **while** restamping the fixed-size soft disc. Gradient wash + ribbon cancel in the same region.

### 6. Spokes vs wash vs growth (different looks)

| Look | Mechanism |
|------|-----------|
| Soft grey cloud filling a predetermined circle | Today’s radial wash over full `fadeRadius` |
| Thin chords across thick strokes | Ribbon facets; max Smooth thins samples |
| Holes / radial lines when holding or rotating | Self-intersecting ribbon winding + join discs |

---

## B) What you want instead (clarified)

**Not:** paint a finished soft circle whose radius is already decided (watercolor bleed across a known disc).

**Yes:** dwell blot behaves like a **black hole that expands**:

1. Starts as a **small opaque black/core disc**.
2. Over dwell time, **radius grows outward** toward the tip’s target radius (speed-modulated width).
3. Soft **gradient only at the expanding rim** (leading edge) — not a center-faded wash of the eventual full circle.
4. Growth **caps at tip radius** (size dial × speed width). Blot-blend dial controls how soft the rim is and how fast it grows—not an oversized cloud past the tip.

```mermaid
flowchart LR
  t0[t0 small opaque core]
  t1[t1 larger solid plus soft rim]
  t2[t2 near tip radius soft rim]
  t0 --> t1 --> t2
```

Join discs on a **moving** stroke stay instantaneous (one stamp at current nib radius) with solid core + thin soft rim — they do not animate growth; only **dwell / near-stationary** pools grow over time.

---

## C) The fix

### Fix 1 — Per-quad ribbon fill (winding holes)

Keep `ribbonSides`. Change `fillInkRibbon` to per-segment quads (`left[i]→left[i+1]→right[i+1]→right[i]`), each filled `source-over`. Overlaps stack; no winding cancel.

### Fix 2 — Growing dwell blot (core → expand → soft rim)

**Disc-primary while near-stationary** (extend short-path so many coincident dwell samples never build a fighting ribbon).

**Growth state** (dwell time or dwell tick count / slowness):

- `targetR` = painted tip half-width at current style (speed width included).
- `growT` = 0…1 from dwell progress (e.g. ease-out over ~dwell ticks or wall ms; blot-blend can shorten/lengthen).
- `outerR = mix(minCoreR, targetR, growT)` — starts tiny, expands to tip.
- `innerR = outerR * (1 - rimFraction(blend))` — solid black/opaque core; soft only in `innerR…outerR`.

Each dwell repaint: clear is already full live replay — stamp disc at current `outerR` with solid core + rim fade. Visually the pool **grows**; it does not flash a full soft circle on tip-down.

Tip-down first frame: tiny hard core (or very small disc), not a large watercolor blot.

### Fix 3 — Join discs on moving strokes

At curvature joins: one stamp at **current** nib `radius`, solid core + annular rim fade (`createRadialGradient` from `innerR` to `outerR=radius`). No temporal growth; no overshoot past tip.

### Fix 4 — Blot-blend dial

- **0%** — hard discs; dwell growth still expands as a hard circle (or growth disabled / instant hard tip disc — prefer hard expanding disc with no soft rim).
- **100%** — softer / wider rim band + faster or more pronounced growth feel; still `outerR ≤ tip radius`.
- Settings hint: soft rim + how the dwell pool spreads—not “halo outside the stroke.”

### Fix 5 — Tests

- Dwell-like sequence: disc radius increases with dwell progress; early frames smaller than tip radius.
- Annular paint: opaque inside `innerR`, fade to outer; outer ≤ tip radius.
- Per-quad: self-crossing ribbon does not cancel.
- Near-stationary with many points: disc-primary (no ribbon polygon).

---

## Files

| File | Role |
|------|------|
| `app/src/canvas/rasterInk.ts` | Per-quad fill; growing / annular disc API; dwell disc-primary gate |
| `app/src/canvas/RasterInkLayer.tsx` | Pass dwell progress / tick into paint if needed |
| `app/src/components/SettingsModal.tsx` | Blot-blend hint |
| `app/src/canvas/rasterInk.test.ts` | Growth + annular + per-quad tests |

## Explicitly not changing

- Smooth dial algorithm (further densify-under-speed later if facets remain after winding/growth fixes).
- Host-scroll / coach (already shipped).
