/**
 * Dev tool, not a check: render viz programs through the real renderers and
 * write an SVG filmstrip per program, so a diagram can be *looked at* without
 * the desktop window.
 *
 * ```bash
 * cd app
 * LC_VIZ_IN=/path/viz-programs.json LC_VIZ_OUT=/path/out npx vitest run svgdump
 * ```
 *
 * Skips itself when `LC_VIZ_IN` is unset.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

import { agentSlotOrigin } from "../templates/regions";
import { parseVizProgram } from "./schema";
import { renderViz } from "./render/index";

const IN = process.env.LC_VIZ_IN;
const OUT = process.env.LC_VIZ_OUT ?? ".";

const FONTS = {
  1: "Segoe UI, sans-serif",
  2: "Comic Sans MS, cursive",
  3: "Cascadia Code, Consolas, monospace",
};

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One skeleton to SVG. Only the three shapes the renderers actually emit. */
function toSvg(el) {
  const stroke = el.strokeColor ?? "#1e1e1e";
  const fill = el.backgroundColor && el.backgroundColor !== "transparent" ? el.backgroundColor : "none";
  const w = el.width ?? 0;
  const h = el.height ?? 0;
  const parts = [];

  if (el.type === "rectangle") {
    const r = el.roundness ? 6 : 0;
    parts.push(
      `<rect x="${el.x}" y="${el.y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${el.strokeWidth ?? 1}"/>`,
    );
    if (el.label?.text) {
      const size = el.label.fontSize ?? 16;
      parts.push(
        `<text x="${el.x + w / 2}" y="${el.y + h / 2}" font-family="${FONTS[3]}" font-size="${size}" fill="${el.label.strokeColor ?? stroke}" text-anchor="middle" dominant-baseline="central">${esc(el.label.text)}</text>`,
      );
    }
  } else if (el.type === "text") {
    const size = el.fontSize ?? 16;
    // Excalidraw anchors text top-left; SVG baselines from the bottom.
    const anchor = el.textAlign === "center" ? "middle" : el.textAlign === "right" ? "end" : "start";
    const x = el.textAlign === "center" ? el.x + w / 2 : el.textAlign === "right" ? el.x + w : el.x;
    for (const [i, line] of el.text.split("\n").entries()) {
      parts.push(
        `<text x="${x}" y="${el.y + size * (i + 1)}" font-family="${FONTS[el.fontFamily ?? 1]}" font-size="${size}" fill="${stroke}" text-anchor="${anchor}">${esc(line)}</text>`,
      );
    }
  } else if (el.type === "arrow" || el.type === "line") {
    const pts = (el.points ?? [[0, 0]]).map(([px, py]) => `${el.x + px},${el.y + py}`).join(" ");
    parts.push(
      `<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="${el.strokeWidth ?? 1}"${el.type === "arrow" ? ' marker-end="url(#a)"' : ""}/>`,
    );
    if (el.label?.text) {
      const last = el.points?.[el.points.length - 1] ?? [0, 0];
      parts.push(
        `<text x="${el.x + last[0]}" y="${el.y + last[1] + 16}" font-family="${FONTS[3]}" font-size="12" fill="${stroke}" text-anchor="middle">${esc(el.label.text)}</text>`,
      );
    }
  }
  return parts.join("\n  ");
}

function bounds(els) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of els) {
    const w = el.width ?? 0;
    const h = el.height ?? 0;
    const xs = [el.x, el.x + w];
    const ys = [el.y, el.y + h];
    for (const [px, py] of el.points ?? []) {
      xs.push(el.x + px);
      ys.push(el.y + py);
    }
    if (el.type === "text") ys.push(el.y + (el.fontSize ?? 16) * (el.text?.split("\n").length ?? 1));
    minX = Math.min(minX, ...xs);
    maxX = Math.max(maxX, ...xs);
    minY = Math.min(minY, ...ys);
    maxY = Math.max(maxY, ...ys);
  }
  return { minX, minY, maxX, maxY };
}

/** Every frame of a program, stacked, so a trace reads as a filmstrip. */
function filmstrip(program, title) {
  const origin = agentSlotOrigin(0);
  const frames = program.frames.map((_, i) => renderViz(program, i, origin));
  const each = frames.map(bounds);
  const width = Math.max(...each.map((b) => b.maxX - b.minX)) + 40;
  const heights = each.map((b) => b.maxY - b.minY + 28);

  let y = 44;
  const body = [];
  for (const [i, els] of frames.entries()) {
    const b = each[i];
    const dx = 20 - b.minX;
    const dy = y - b.minY;
    body.push(`<g transform="translate(${dx},${dy})">`);
    body.push(`  ${els.map(toSvg).join("\n  ")}`);
    body.push(`</g>`);
    body.push(
      `<text x="8" y="${y - 8}" font-family="${FONTS[1]}" font-size="12" fill="#94a3b8">frame ${i + 1}/${frames.length} — ${esc(program.frames[i].label ?? "")}</text>`,
    );
    y += heights[i] + 34;
  }

  const total = y;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${total}" viewBox="0 0 ${width} ${total}">`,
    `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#5b6478"/></marker></defs>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<text x="8" y="20" font-family="${FONTS[1]}" font-size="14" fill="#0f172a">${esc(title)}</text>`,
    body.join("\n"),
    `</svg>`,
  ].join("\n");
}

describe.skipIf(!IN)("viz svg dump", () => {
  it("renders every collected program to an SVG filmstrip", () => {
    const rows = JSON.parse(fs.readFileSync(IN, "utf8"));
    fs.mkdirSync(OUT, { recursive: true });
    for (const [i, row] of rows.entries()) {
      const program = parseVizProgram(row.program);
      if (!program) {
        console.log(`program ${i} did not parse`);
        continue;
      }
      const name = `${String(i).padStart(2, "0")}-${program.viz}-${program.id}`.replace(/[^a-z0-9-]/gi, "_");
      const file = path.join(OUT, `${name}.svg`);
      fs.writeFileSync(file, filmstrip(program, `${program.viz} · ${program.title || program.id} · ask: ${row.ask}`));
      console.log(`${file}  (${program.frames.length} frames)`);
    }
  });
});
