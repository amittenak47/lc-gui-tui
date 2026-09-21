import { useEffect, useRef, useState } from "react";
import { Tip } from "../components/Tip";
import { artifactRefKey, type ArtifactRef } from "../util/padArtifacts";
import { ARTIFACTS_CHANGED, readArtifact } from "../util/artifactRepository";
import { ArtifactKindIcon, artifactKindLabel } from "./ArtifactKindIcon";
import "./artifacts.css";

function FailGlyph() {
  return (
    <svg className="lc-artifact-line-glyph" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.7v4.1" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
      <circle cx="8" cy="11.15" r="0.85" fill="currentColor" />
    </svg>
  );
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
    ? `${artifactKindLabel(reference.kind)} attachment error`
    : `Open ${artifactKindLabel(reference.kind).toLowerCase()}`;
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
      {failed ? <FailGlyph /> : <ArtifactKindIcon kind={reference.kind} className="lc-artifact-line-glyph" />}
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
