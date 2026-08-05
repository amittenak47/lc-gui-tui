/**
 * Turning a marked-up code page into something a vision model can read.
 *
 * The code on that page is Monaco — HTML, not canvas — so a board export cannot
 * see it: it would come back as ink floating over an empty rectangle, and marks
 * with nothing under them tell a model nothing at all. The annotations only
 * mean something *positioned against the lines they point at*, so the picture
 * has to contain both.
 *
 * So the source is re-rendered here rather than screenshotted. That is possible
 * because the editor is monospaced with word wrap on and a known font size:
 * character cells are uniform, wrap is a column count, and a faithful-enough
 * re-render puts every line at the y a mark was drawn against. It is not
 * pixel-identical to Monaco and does not need to be — nobody looks at this. It
 * exists so a model can answer "which line is this circled".
 */

import { inkOpBounds } from "./inkTiles";
import { applyInkOp, type InkOp } from "./rasterInk";

export interface SceneBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Device pixels per scene unit in the export. Legible without being huge. */
const EXPORT_SCALE = 2;
/** Monospace advance as a fraction of font size — near enough for any mono face. */
const ADVANCE_RATIO = 0.6;
const LINE_HEIGHT_RATIO = 1.5;
/** Left gutter for line numbers, in characters. */
const GUTTER_CHARS = 4;

/**
 * Does any ink land on the code page?
 *
 * This is the whole decision about whether a picture gets sent at all: with no
 * marks over the code there is nothing an image could add that the source text
 * does not already say, and attaching one would cost a vision round-trip to
 * tell the model what it was about to read anyway.
 */
export function hasCodeAnnotations(ops: readonly InkOp[], box: SceneBox): boolean {
  return ops.some((op) => {
    const bounds = inkOpBounds(op);
    return (
      bounds.maxX >= box.minX &&
      bounds.minX <= box.maxX &&
      bounds.maxY >= box.minY &&
      bounds.minY <= box.maxY
    );
  });
}

/** Wrap monospaced source to a column count, keeping blank lines. */
export function wrapSource(source: string, columns: number): string[] {
  const cols = Math.max(8, Math.floor(columns));
  const out: string[] = [];
  for (const raw of source.replace(/\t/g, "    ").split("\n")) {
    if (raw.length <= cols) {
      out.push(raw);
      continue;
    }
    // Continuation lines keep the original indent, the way an editor's wrap
    // does — otherwise a wrapped body line starts at column 0 and the shape of
    // the code, which is most of what a mark is pointing at, is lost.
    const indent = raw.slice(0, Math.min(raw.length - raw.trimStart().length, cols - 8));
    let rest = raw;
    let first = true;
    while (rest.length > 0) {
      const width = first ? cols : cols - indent.length;
      out.push((first ? "" : indent) + rest.slice(0, width));
      rest = rest.slice(width);
      first = false;
    }
  }
  return out;
}

export interface RenderAnnotatedCodeInput {
  source: string;
  /** Committed ink for the whole board; anything outside `box` is clipped away. */
  ops: readonly InkOp[];
  /** Scene rect of the code region — the frame the ink was drawn against. */
  box: SceneBox;
  background: string;
  /** Colour to draw the source in. */
  textColor: string;
  /** Scene-space font size the code is shown at. */
  fontScene: number;
}

/**
 * Base64 PNG of the code with its annotations over it, or "" when there is
 * nothing to draw.
 */
export function renderAnnotatedCode(input: RenderAnnotatedCodeInput): string {
  const width = Math.max(1, input.box.maxX - input.box.minX);
  const height = Math.max(1, input.box.maxY - input.box.minY);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * EXPORT_SCALE));
  canvas.height = Math.max(1, Math.round(height * EXPORT_SCALE));
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = input.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const fontPx = Math.max(6, input.fontScene) * EXPORT_SCALE;
  const advance = fontPx * ADVANCE_RATIO;
  const lineHeight = fontPx * LINE_HEIGHT_RATIO;
  const pad = fontPx * 0.6;
  const gutter = advance * GUTTER_CHARS;
  const columns = Math.max(8, Math.floor((canvas.width - pad * 2 - gutter) / advance));

  ctx.font = `${fontPx}px Consolas, "Cascadia Code", "Courier New", monospace`;
  ctx.textBaseline = "alphabetic";

  // Line numbers track the *source* line, not the wrapped row, so a mark on a
  // continuation still names the line a reader would cite.
  let y = pad + fontPx;
  let sourceLine = 0;
  for (const raw of input.source.replace(/\t/g, "    ").split("\n")) {
    sourceLine += 1;
    const rows = wrapSource(raw, columns);
    for (let row = 0; row < Math.max(1, rows.length); row += 1) {
      if (y > canvas.height) break;
      if (row === 0) {
        ctx.fillStyle = input.textColor;
        ctx.globalAlpha = 0.45;
        ctx.fillText(String(sourceLine).padStart(GUTTER_CHARS - 1, " "), pad, y);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = input.textColor;
      ctx.fillText(rows[row] ?? "", pad + gutter, y);
      y += lineHeight;
    }
    if (y > canvas.height) break;
  }

  /*
   * The ink, in the same frame the writer drew it in.
   *
   * Scene → export pixels is one translate and one scale, so a mark lands at
   * the same fraction down the box as it did on screen. That is the only
   * property this picture has to get right: the model is being asked which line
   * the mark is on, and the answer is entirely in the y.
   */
  ctx.setTransform(
    EXPORT_SCALE,
    0,
    0,
    EXPORT_SCALE,
    -input.box.minX * EXPORT_SCALE,
    -input.box.minY * EXPORT_SCALE,
  );
  ctx.save();
  ctx.beginPath();
  ctx.rect(input.box.minX, input.box.minY, width, height);
  ctx.clip();
  for (const op of input.ops) {
    const bounds = inkOpBounds(op);
    if (
      bounds.maxX < input.box.minX ||
      bounds.minX > input.box.maxX ||
      bounds.maxY < input.box.minY ||
      bounds.minY > input.box.maxY
    ) {
      continue;
    }
    applyInkOp(ctx, op, EXPORT_SCALE);
  }
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  return canvas.toDataURL("image/png");
}
