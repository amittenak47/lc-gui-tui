/**
 * Which set of annotations to open, when a file has more than one.
 *
 * A file's bytes and its annotations used to be the same thing — one hash, one
 * board — so opening a PDF had nothing to ask. Now a file can carry several
 * independent sets (`annotateStore`, keyed by sidecar id), and only the reader
 * knows which one they meant. This is the question.
 *
 * It is deliberately the same dialog as {@link AnnotateDialog}: same backdrop,
 * same modal shell, same HoldButtons. A reader who has opened Recent has
 * already learned this list.
 *
 * Cancel is a real answer. The alternative — pick one for them — is the
 * behaviour this whole change exists to remove.
 */

import { HoldButton } from "../components/HoldButton";
import { annotateDocLabel, type AnnotateDocMeta } from "../util/annotateStore";

/** An existing set's id, a brand new set, or "do not open this at all". */
export type SidecarChoice = { kind: "open"; id: string } | { kind: "new" } | { kind: "cancel" };

export interface SidecarChooserProps {
  /** File name as opened — the thing all these sets have in common. */
  docName: string;
  /** Every set drawn over these bytes, newest first. */
  matches: readonly AnnotateDocMeta[];
  onChoose: (choice: SidecarChoice) => void;
}

export function SidecarChooser({ docName, matches, onChoose }: SidecarChooserProps) {
  return (
    <div
      className="lc-settings-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onChoose({ kind: "cancel" });
      }}
    >
      <div
        className="lc-settings-modal lc-attempt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Annotations for ${docName}`}
      >
        <div className="lc-settings-head">
          <h2>Annotations for “{docName}”</h2>
        </div>
        <p className="lc-muted">
          {matches.length} sets of annotations were drawn over this file. Open one, or start
          another.
        </p>
        <div className="lc-settings-choice">
          {matches.map((meta) => (
            <HoldButton
              key={meta.id}
              label={`Open ${annotateDocLabel(meta)}`}
              className="lc-hold-choice"
              onConfirm={() => onChoose({ kind: "open", id: meta.id })}
            >
              <strong>{annotateDocLabel(meta)}</strong>
              <span className="lc-muted">
                Annotated {new Date(meta.updatedAt).toLocaleString()}
              </span>
            </HoldButton>
          ))}
          <HoldButton
            label="New annotation set on this file"
            className="lc-hold-choice"
            onConfirm={() => onChoose({ kind: "new" })}
          >
            <strong>New annotation set</strong>
            <span className="lc-muted">
              A blank board over the same file. The sets above are untouched.
            </span>
          </HoldButton>
        </div>
        <div className="lc-settings-foot">
          <button
            type="button"
            className="lc-secondary"
            onClick={() => onChoose({ kind: "cancel" })}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
