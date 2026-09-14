import { FONT_CODE } from "../templates/skeleton";

export interface SceneTextStyle {
  text?: string;
  originalText?: string;
  fontSize?: number;
  fontFamily?: number;
  lineHeight?: number;
  width?: number;
  autoResize?: boolean;
}

export function sceneTextFont(family?: number): string {
  return family === FONT_CODE
    ? "ui-monospace, Cascadia Code, Consolas, monospace"
    : "Helvetica, Arial, sans-serif";
}

let measureContext: CanvasRenderingContext2D | null = null;

/** One layout for editing, selection bounds, saved text and canvas/export paint. */
export function layoutSceneText(style: SceneTextStyle, context?: CanvasRenderingContext2D) {
  const fontSize = style.fontSize ?? 20;
  const lineHeight = style.lineHeight ?? 1.25;
  const originalText = (style.originalText ?? style.text ?? "").replace(/\r\n?/g, "\n");
  if (!context && !measureContext && typeof document !== "undefined") {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  const ctx = context ?? measureContext;
  if (ctx) ctx.font = `${fontSize}px ${sceneTextFont(style.fontFamily)}`;
  const measure = (text: string) => ctx?.measureText(text).width ?? Array.from(text).length * fontSize * 0.6;
  const fixed = style.autoResize === false;
  const wrapWidth = Math.max(fontSize, style.width ?? fontSize * 8);
  const lines: string[] = [];
  for (const paragraph of originalText.split("\n")) {
    if (!fixed || measure(paragraph) <= wrapWidth) {
      lines.push(paragraph);
      continue;
    }
    // Prefer word boundaries, falling back to characters for long words/URLs.
    let line = "";
    for (const token of paragraph.match(/\S+\s*|\s+/gu) ?? []) {
      if (line && measure(line + token.trimEnd()) > wrapWidth) {
        lines.push(line.trimEnd());
        line = "";
      }
      for (const char of Array.from(token)) {
        if (line && !/\s/u.test(char) && measure(line + char) > wrapWidth) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
    }
    lines.push(line.trimEnd());
  }
  return {
    originalText,
    text: lines.join("\n"),
    lines,
    width: fixed ? wrapWidth : Math.max(fontSize, ...lines.map(measure)),
    height: Math.max(1, lines.length) * fontSize * lineHeight,
    fontSize,
    lineHeight,
  };
}

export function fitSceneText<T extends SceneTextStyle>(element: T): T & { width: number; height: number } {
  const { text, originalText, width, height } = layoutSceneText(element);
  return { ...element, text, originalText, width, height };
}
