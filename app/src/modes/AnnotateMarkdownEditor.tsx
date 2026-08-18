/**
 * Editing an owned note's markdown source.
 *
 * Only owned notes reach here — the ones New file made, where `content.source`
 * *is* the document. Imported files never do: their entry holds a copy kept
 * for reopening, and writing to it would break the promise the whole annotate
 * library is built on.
 *
 * One Monaco over the whole source, not a notebook of per-block widgets.
 * Fenced code is just text here and becomes `<pre><code>` when the page goes
 * back to being paper; mounting an editor per fence on the annotate surface
 * would put a second thing under the pen that wants the same pointer.
 *
 * Monaco is ~4 MB and is not loaded until Edit is entered — which is also why
 * this is a separate module from the paper it replaces. If it fails to load or
 * throws, a plain textarea takes over: a note you cannot type into is worse
 * than a note without syntax colours.
 */

import { Component, Suspense, lazy, useState, type ErrorInfo, type ReactNode } from "react";

import type { BoardReadingSize } from "./codeFontSize";

const MonacoBlock = lazy(() => import("./MonacoBlock"));

export interface AnnotateMarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  themeId?: string;
  readingSize?: BoardReadingSize;
  /**
   * The editor's laid-out height, so the board page can grow to it.
   *
   * Same contract as the paper's `onMeasure`: the page frame has to cover the
   * whole document or its last lines sit outside the page.
   */
  onMeasure?: (height: number) => void;
}

/** The fence a reader gets from Insert code block, when nothing says otherwise. */
export const DEFAULT_FENCE_LANGUAGE = "python";

/**
 * Put a fenced block at the cursor, and say where the cursor should end up.
 *
 * Returned rather than applied so the caller owns the buffer — and so this is
 * testable without an editor. The offset points *inside* the fence, because
 * landing the reader on the closing backticks would make them navigate out of
 * the thing they just asked for.
 */
export function insertFence(
  source: string,
  at: number,
  language = DEFAULT_FENCE_LANGUAGE,
): { source: string; cursor: number } {
  const cut = Math.max(0, Math.min(at, source.length));
  const before = source.slice(0, cut);
  const after = source.slice(cut);
  // Only add the separating newlines that are not already there, so repeated
  // inserts do not walk the block down the page.
  const lead = before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const tail = after.startsWith("\n") || after.length === 0 ? "" : "\n";
  const block = `\`\`\`${language}\n\n\`\`\`\n`;
  return {
    source: `${before}${lead}${block}${tail}${after}`,
    cursor: before.length + lead.length + language.length + 4,
  };
}

export function AnnotateMarkdownEditor({
  value,
  onChange,
  themeId = "blue",
  readingSize = "M",
  onMeasure,
}: AnnotateMarkdownEditorProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <textarea
        className="lc-md-edit-fallback"
        value={value}
        spellCheck={false}
        aria-label="Note source"
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <div className="lc-md-edit-host">
      <ErrorBoundary onError={() => setFailed(true)}>
        <Suspense fallback={<div className="lc-md-edit-loading">loading editor…</div>}>
          <MonacoBlock
          value={value}
          language="markdown"
          themeId={themeId}
          fontSizePref={readingSize}
          height="100%"
          onChange={onChange}
          onReady={() => {}}
          onContentHeight={onMeasure}
        />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

class ErrorBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    this.props.onError();
  }

  render() {
    return this.state.crashed ? null : this.props.children;
  }
}
