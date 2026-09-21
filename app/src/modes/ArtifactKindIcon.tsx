import type { ArtifactKind } from "../util/padArtifacts";

export function artifactKindLabel(kind: ArtifactKind): string {
  if (kind === "whiteboard") return "Board";
  if (kind === "code") return "Code";
  return "Note";
}

export function ArtifactKindIcon({
  kind,
  className = "lc-artifact-kind-icon",
}: {
  kind: ArtifactKind;
  className?: string;
}) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden>
      {kind === "whiteboard" ? (
        <>
          <rect
            x="2.6"
            y="3.5"
            width="10.8"
            height="9"
            rx="1.3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.35"
          />
          <path
            d="M5.1 9.3c.7-1.5 1.7-2.3 2.6-1.2.9 1.1 1.6.2 2.5-1.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
          />
        </>
      ) : kind === "code" ? (
        <path
          d="M6.2 4.5 2.9 8l3.3 3.5M9.8 4.5 13.1 8l-3.3 3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <>
          <path
            d="M4.2 2.8h5.3L11.8 5.2v8H4.2V2.8Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinejoin="round"
          />
          <path
            d="M9.5 2.9v2.4h2.2M6 8.3h4M6 10.5h2.7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}
