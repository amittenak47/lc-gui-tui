import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tip } from "../components/Tip";
import { artifactRefKey, type ArtifactKind, type ArtifactRef } from "../util/padArtifacts";
import { ARTIFACTS_CHANGED, readArtifact } from "../util/artifactRepository";
import "./artifacts.css";

function KindGlyph({ children }: { children: ReactNode }) {
  return (
    <svg className="lc-artifact-line-glyph" viewBox="0 0 16 16" aria-hidden>
      {children}
    </svg>
  );
}

function BoardGlyph() {
  return (
    <KindGlyph>
      <rect x="2.6" y="3.5" width="10.8" height="9" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M5.1 9.3c.7-1.5 1.7-2.3 2.6-1.2.9 1.1 1.6.2 2.5-1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </KindGlyph>
  );
}

function NoteGlyph() {
  return (
    <KindGlyph>
      <path d="M4.2 2.8h5.3L11.8 5.2v8H4.2V2.8Z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
      <path
        d="M9.5 2.9v2.4h2.2M6 8.3h4M6 10.5h2.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </KindGlyph>
  );
}

function CodeGlyph() {
  return (
    <KindGlyph>
      <path
        d="M6.2 4.5 2.9 8l3.3 3.5M9.8 4.5 13.1 8l-3.3 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </KindGlyph>
  );
}

function FailGlyph() {
  return (
    <KindGlyph>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.7v4.1" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
      <circle cx="8" cy="11.15" r="0.85" fill="currentColor" />
    </KindGlyph>
  );
}

function kindGlyph(kind: ArtifactKind) {
  if (kind === "whiteboard") return <BoardGlyph />;
  if (kind === "code") return <CodeGlyph />;
  return <NoteGlyph />;
}

function kindLabel(kind: ArtifactKind) {
  if (kind === "whiteboard") return "Board";
  if (kind === "code") return "Code";
  return "Note";
}

function readError(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function savedCaption(title: string | null) {
  const name = title?.trim();
  return name ? `'${name}' saved` : "saved";
}

function ArtifactCard({ reference, onOpen }: { reference: ArtifactRef; onOpen: (ref: ArtifactRef) => void }) {
  const [ok, setOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    let visible = typeof IntersectionObserver === "undefined";
    const refresh = () => {
      if (!visible) return;
      void readArtifact(reference)
        .then((result) => {
          if (!cancelled) {
            setOk(true);
            setError(null);
            setTitle(result.item.title);
          }
        })
        .catch((cause) => {
          if (!cancelled) {
            setOk(false);
            setError(readError(cause));
          }
        });
    };
    const observer = typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
          visible = entries.some((entry) => entry.isIntersecting);
          if (visible) refresh();
        });
    if (anchor.current) observer?.observe(anchor.current);
    refresh();
    window.addEventListener(ARTIFACTS_CHANGED, refresh);
    return () => {
      cancelled = true;
      observer?.disconnect();
      window.removeEventListener(ARTIFACTS_CHANGED, refresh);
    };
  }, [artifactRefKey(reference)]);

  const failed = Boolean(error);
  const label = failed
    ? `${kindLabel(reference.kind)} attachment error`
    : `Open ${kindLabel(reference.kind).toLowerCase()}`;
  const icon = (
    <button
      ref={anchor}
      type="button"
      className="lc-artifact-line-icon"
      aria-label={label}
      title={error ?? undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(reference);
      }}
    >
      {failed ? <FailGlyph /> : kindGlyph(reference.kind)}
    </button>
  );

  return (
    <span className={`lc-artifact-line${failed ? " is-bad" : ok ? " is-ok" : " is-loading"}`}>
      {failed ? (
        <Tip tip={error!} placement="top">
          {icon}
        </Tip>
      ) : (
        icon
      )}
      <span className="lc-artifact-line-text">{savedCaption(title)}</span>
    </span>
  );
}

export function ArtifactCards({ references, onOpen }: { references?: ArtifactRef[]; onOpen: (ref: ArtifactRef) => void }) {
  return references?.length ? (
    <span className="lc-artifact-cards">
      {references.map((ref) => (
        <ArtifactCard key={artifactRefKey(ref)} reference={ref} onOpen={onOpen} />
      ))}
    </span>
  ) : null;
}
