/**
 * Handwriting → text, behind an interface.
 *
 * On Android this is **ML Kit Digital Ink Recognition** — on-device, offline,
 * free — reached through the Kotlin plugin in
 * `src-tauri/android/inkrecognition/`. That is what makes a *text-only* local
 * model viable for the 15-second loop: without it, the ambient coach would need
 * a local vision model able to read handwriting.
 *
 * On desktop there is no ML Kit, so {@link NoopRecognizer} returns nothing and
 * the caller falls back to typed text or a PNG sent to a vision model. Keeping
 * both behind {@link InkRecognizer} is what makes that fallback a one-line
 * swap.
 */

import type { InkStroke } from "./capture";

export interface InkRecognizer {
  readonly name: string;
  /** Whether this recognizer can actually run here, checked once at startup. */
  available(): Promise<boolean>;
  /** Recognized text, or "" when there is nothing legible. */
  recognize(strokes: InkStroke[]): Promise<string>;
}

/** Invoke a Tauri command. Injected so the recognizers stay testable. */
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * ML Kit, via the Tauri plugin. The plugin owns model download and caching;
 * from here it is one command that takes stroke point arrays and returns text.
 */
export class MlKitRecognizer implements InkRecognizer {
  readonly name = "mlkit";

  constructor(private readonly invoke: Invoke) {}

  async available(): Promise<boolean> {
    try {
      return await this.invoke<boolean>("plugin:inkrecognition|is_available");
    } catch {
      return false;
    }
  }

  async recognize(strokes: InkStroke[]): Promise<string> {
    if (strokes.length === 0) return "";
    const result = await this.invoke<{ text: string }>("plugin:inkrecognition|recognize", {
      strokes: strokes.map((stroke) => ({
        x: stroke.points.map((p) => p.x),
        y: stroke.points.map((p) => p.y),
      })),
    });
    return result.text ?? "";
  }
}

/** Desktop and anywhere ML Kit is missing. */
export class NoopRecognizer implements InkRecognizer {
  readonly name = "none";

  async available(): Promise<boolean> {
    return true;
  }

  async recognize(): Promise<string> {
    return "";
  }
}

/**
 * The first recognizer that reports itself usable. Falls back rather than
 * failing, so the desktop build works with zero Android setup.
 */
export async function pickRecognizer(candidates: InkRecognizer[]): Promise<InkRecognizer> {
  for (const candidate of candidates) {
    if (await candidate.available()) return candidate;
  }
  return new NoopRecognizer();
}

/**
 * Merge recognized handwriting with text the student typed. Both go to the
 * coach: on desktop only the typed half exists, on the tablet usually only the
 * handwritten half.
 */
export function mergeRecognized(handwriting: string, typed: string): string {
  const parts = [handwriting.trim(), typed.trim()].filter((part) => part.length > 0);
  return parts.join("\n");
}
