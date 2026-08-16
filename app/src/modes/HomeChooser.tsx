/**
 * Landing screen — Practice, Whiteboard, or Annotate.
 */

import { FEATURE_LEETCODE } from "../featureFlags";

export interface HomeChooserProps {
  onPractice: () => void;
  onWhiteboard: () => void;
  onAnnotate: () => void;
}

export function HomeChooser({ onPractice, onWhiteboard, onAnnotate }: HomeChooserProps) {
  return (
    <div className="lc-home-chooser" role="navigation" aria-label="Choose a workspace">
      <div className="lc-home-chooser-head">
        <h1 className="lc-home-chooser-title">What do you want to do?</h1>
        <p className="lc-home-chooser-lead lc-muted">
          Pick a mode to open. You can switch anytime from the header.
        </p>
      </div>
      <div className="lc-home-chooser-grid">
        {FEATURE_LEETCODE && (
          <button type="button" className="lc-home-card" onClick={onPractice}>
            <span className="lc-home-card-kicker">LeetCode</span>
            <strong className="lc-home-card-title">Practice</strong>
            <span className="lc-home-card-blurb">Browse problems and run tests in this app.</span>
          </button>
        )}
        <button type="button" className="lc-home-card" onClick={onWhiteboard}>
          <span className="lc-home-card-kicker">Scratch</span>
          <strong className="lc-home-card-title">Whiteboard</strong>
          <span className="lc-home-card-blurb">Freeform pages for sketches, notes, and diagrams.</span>
        </button>
        <button type="button" className="lc-home-card" onClick={onAnnotate}>
          <span className="lc-home-card-kicker">Reading</span>
          <strong className="lc-home-card-title">Annotate</strong>
          <span className="lc-home-card-blurb">Mark up PDFs, docs, code, and web pages.</span>
        </button>
      </div>
    </div>
  );
}
