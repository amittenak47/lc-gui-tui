# Fix log: Code document pad (readonly annotatable source files)

**Date:** 2026-08-08  
**Branch:** `cursor/code-doc-pad-c575`  
**Base:** `origin/claude/work-in-progress-2z1i3q` @ `cc36e932bfaab73e0b69ff03e57324816d4e2950`  
**HEAD:** `1b71bf7f25954107d841267cdb1d22d977598c6b`  
**PR:** https://github.com/amittenak47/lc-gui-tui/pull/2  
**Repo:** https://github.com/amittenak47/lc-gui-tui

## Summary

Expands the document pad (markdown / PDF / EPUB) to open arbitrary **source files** as readonly code: escaped `<pre><code>` via `CodeDocument`, no Monaco, no markdown parser. File typing, picker `accept`, language metadata, localStorage size guard, horizontal scroll in reading mode, and library persistence for `docType: "code"`.

## Files touched (12)

---

### 1. `app/src/App.tsx`

**Before:** https://github.com/amittenak47/lc-gui-tui/blob/cc36e932bfaab73e0b69ff03e57324816d4e2950/app/src/App.tsx

```tsx
/** The markdown being annotated: its text, its name, and its content hash. */
const [mdInkSource, setMdInkSource] = useState<{
  name: string;
  /** Markdown text; empty for PDF and EPUB. */
  text: string;
  hash: string;
  docType: DocType;
```

**After:** `app/src/App.tsx` (lines 306–312, 1695–1712, 4151–4157)

```tsx
/** The document being annotated: its text, its name, and its content hash. */
const [mdInkSource, setMdInkSource] = useState<{
  name: string;
  /** Markdown/code text; empty for PDF and EPUB. */
  text: string;
```

```tsx
if (
  (docType === "code" || docType === "markdown") &&
  text.length > CODE_SOURCE_MAX_CHARS
) {
  throw new Error(/* … */);
}
```

```tsx
) : mdInkSource.docType === "code" ? (
  <CodeDocument
    source={mdInkSource.text}
    language={languageForName(mdInkSource.name)}
    onMeasure={onMdInkMeasure}
    selectable={!annotateCode}
  />
```

**Behavior**

1. **Imports and wiring**
   - Imports `CodeDocument`, `CODE_SOURCE_MAX_CHARS`, `languageForName`.
   - Renders `CodeDocument` when `mdInkSource.docType === "code"` (between EPUB and markdown branches).

2. **Open path**
   - Rejects markdown/code text longer than `CODE_SOURCE_MAX_CHARS` before hash/store work, with a user-facing size error.

3. **Copy and UX strings**
   - Comments and tooltips generalize from “markdown” to “document” / “source file”.
   - Document toolbar tip: `.md, source file, .pdf or .epub`.

---

### 2. `app/src/canvas/scrollHost.ts`

**Before:** https://github.com/amittenak47/lc-gui-tui/blob/cc36e932bfaab73e0b69ff03e57324816d4e2950/app/src/canvas/scrollHost.ts

```ts
const doc = start?.closest(".lc-md-ink-doc");
```

**After:** `app/src/canvas/scrollHost.ts` (lines 1–28)

```ts
/**
 * Nested scrollers inside a document page.
 */
const doc = start?.closest(".lc-md-ink-doc, .lc-code-doc, .lc-epub-doc");
```

**Behavior**

1. **Horizontal scroll discovery**
   - `horizontalScrollHost` treats `.lc-code-doc` and `.lc-epub-doc` like markdown pages when finding nested `overflow-x` scrollers.
   - Enables sideways pan on wide code lines in reading mode without the board gatekeeper stealing the gesture.

---

### 3. `app/src/canvas/scrollHost.test.ts`

**Before:** https://github.com/amittenak47/lc-gui-tui/blob/cc36e932bfaab73e0b69ff03e57324816d4e2950/app/src/canvas/scrollHost.test.ts

```ts
it("takes the nearest scroller when boxes nest", () => {
  const { doc, code } = buildDoc();
  const outer = document.createElement("div");
  outer.style.overflowX = "auto";
  // … nests pre inside outer inside markdown doc …
  expect(horizontalScrollHost(code)).toBe(pre);
});
```

**After:** `app/src/canvas/scrollHost.test.ts` (lines 82–101)

```ts
it("finds a scroller inside a whole-file code document", () => {
  const doc = document.createElement("div");
  doc.className = "lc-code-doc";
  const pre = document.createElement("pre");
  pre.className = "lc-code-doc-pre";
  pre.style.overflowX = "auto";
  // … board → slot → lc-code-doc → pre → code …
  expect(horizontalScrollHost(code)).toBe(pre);
});
```

**Behavior**

1. **Regression coverage**
   - Replaces generic nested-scroller test with DOM shaped like `CodeDocument` output so `closest(".lc-code-doc")` is exercised.

---

### 4. `app/src/modes/CodeDocument.tsx` (new)

**Before:** did not exist at base (`cc36e932`).

**After:** `app/src/modes/CodeDocument.tsx` (lines 1–87)

```tsx
export function renderCode(source: string, language = "plaintext"): string {
  const lang = language.replace(/[^a-zA-Z0-9_+#-]/g, "") || "plaintext";
  return `<pre class="lc-code-doc-pre"><code class="language-${lang}">${escapeHtml(source)}</code></pre>`;
}

export function CodeDocument({ source, language = "plaintext", onMeasure, selectable = false }: CodeDocumentProps) {
  // ResizeObserver → onMeasure(scrollHeight); dangerouslySetInnerHTML with escaped HTML
  return (
    <div className="lc-code-doc lc-md-ink-carbon" aria-hidden={selectable ? undefined : true} … />
  );
}
```

**Behavior**

1. **Rendering**
   - Whole file as one escaped `<pre><code>` — no `marked`, no Monaco.
   - `language-*` class for future Highlight.js; no coloring today.

2. **Safety**
   - `escapeHtml` neutralizes `& < > " '`.
   - Language id sanitized before embedding in `class`.

3. **Pad contract (matches `MdInkDocument`)**
   - Full content height via `onMeasure` + `ResizeObserver`.
   - `aria-hidden` when not selectable (annotate mode); exposed in scroll/reading mode.

---

### 5. `app/src/modes/codeDocument.test.ts` (new)

**Before:** did not exist at base.

**After:** `app/src/modes/codeDocument.test.ts` (lines 1–39)

```ts
describe("escapeHtml", () => { /* </pre><script> … */ });
describe("renderCode", () => {
  it("wraps escaped source in a pre/code with a language class", () => { … });
  it("strips unsafe characters from the language id", () => { … });
});
```

**Behavior**

1. **Unit tests for `CodeDocument` helpers**
   - Escaping, XSS-ish payloads, language class stripping, plaintext default.

---

### 6. `app/src/modes/MdInkDialog.tsx`

**Before:** https://github.com/amittenak47/lc-gui-tui/blob/cc36e932bfaab73e0b69ff03e57324816d4e2950/app/src/modes/MdInkDialog.tsx

```tsx
? "Discard throws away this session's annotations. The markdown file itself is never changed. Hold to confirm."
: … "Open a markdown file to annotate, or reopen a recent one."
<strong>Open markdown…</strong>
<span className="lc-muted">Pick a .md, .pdf or .epub to annotate.</span>
```

**After:** `app/src/modes/MdInkDialog.tsx` (lines 97–100, 175–201, 222)

```tsx
? "Discard throws away this session's annotations. The file itself is never changed. Hold to confirm."
: … "Open a document to annotate, or reopen a recent one."
<label="Open document" …>
  <strong>Open document…</strong>
  <span className="lc-muted">Pick a .md, source file, .pdf or .epub to annotate.</span>
```

**Behavior**

1. **Dialog copy**
   - All user-facing strings generalized from markdown-only to any document type including source files.
   - Sidecar/export text: “beside the source” instead of “beside the .md”.

---

### 7. `app/src/styles.css`

**Before:** https://github.com/amittenak47/lc-gui-tui/blob/cc36e932bfaab73e0b69ff03e57324816d4e2950/app/src/styles.css (no `.lc-code-doc` rules; table styles followed `pre code` block at ~2468)

**After:** `app/src/styles.css` (lines 2471–2516)

```css
.lc-code-doc { … overflow-wrap: normal; word-break: normal; }
.lc-code-doc-pre { overflow-x: auto; white-space: pre; font-family: var(--mono, …); tab-size: 4; }
.lc-board-reading .lc-page-content-slot .lc-code-doc-pre {
  pointer-events: auto;
  touch-action: pan-x;
  overscroll-behavior-x: contain;
}
```

**Behavior**

1. **Layout**
   - Monospace, no soft wrap (ink aligns with visual columns).
   - Same carbon padding rhythm as markdown/EPUB pages.

2. **Reading mode**
   - `lc-code-doc-pre` receives pointer events and horizontal touch pan so long lines scroll sideways.

---

### 8. `app/src/util/codeLanguages.ts` (new)

**Before:** did not exist at base.

**After:** `app/src/util/codeLanguages.ts` (lines 10–11, 20–156, 195–217)

```ts
export const CODE_SOURCE_MAX_CHARS = 1_500_000;
export const CODE_LANGUAGE_BY_EXT: Readonly<Record<string, string>> = { ".py": "python", … };
export function languageForName(name: string): string { … }
export function isCodeName(name: string): boolean { … }
```

**Behavior**

1. **Single source of truth**
   - Extension → Highlight.js-style language id map (~100+ extensions).
   - Basename map: `Dockerfile`, `Makefile`, `Gemfile`, `go.mod`, etc.

2. **Picker support**
   - `codeAcceptExtensions()` derives sorted extension list for `DOCUMENT_ACCEPT`.

3. **Size limit**
   - `CODE_SOURCE_MAX_CHARS` = 1.5M characters for localStorage guard.

4. **Fallbacks**
   - Unknown extension → `plaintext` language id; `isCodeName` false for extensionless unknowns (but `docTypeForName` still opens as code).

---

### 9. `app/src/util/mdInkFs.ts`

**Before:** https://github.com/amittenak47/lc-gui-tui/blob/cc36e932bfaab73e0b69ff03e57324816d4e2950/app/src/util/mdInkFs.ts

```ts
export const DOCUMENT_ACCEPT = `${MARKDOWN_ACCEPT},.pdf,application/pdf,.epub,application/epub+zip`;
const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd", ".txt"];
export function docTypeForName(name: string): DocType {
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".epub")) return "epub";
  return "markdown";
}
// pickDocumentFile: if (docType === "markdown") { file.text() … }
```

**After:** `app/src/util/mdInkFs.ts` (lines 20–36, 74–86, 272–277)

```ts
export { CODE_SOURCE_MAX_CHARS, languageForName } from "./codeLanguages";
const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd"]; // .txt removed
export const DOCUMENT_ACCEPT = [MARKDOWN_ACCEPT, ".pdf,…", ".epub,…", CODE_ACCEPT, "text/plain"].join(",");
export function docTypeForName(name: string): DocType {
  … if (isMarkdownName(name)) return "markdown";
  if (isCodeName(name)) return "code";
  return "code";
}
export function isTextDocType(docType: DocType): boolean {
  return docType === "markdown" || docType === "code";
}
// pickDocumentFile: if (isTextDocType(docType)) { file.text() … }
```

**Behavior**

1. **File typing**
   - `.txt` is code, not markdown.
   - Unrecognized names default to `code` (escaped plaintext), not markdown.

2. **Picker**
   - `DOCUMENT_ACCEPT` includes all code extensions plus `text/plain`.

3. **Read path**
   - Both markdown and code read via `file.text()`; PDF/EPUB still `arrayBuffer()`.

4. **Re-exports**
   - `CODE_SOURCE_MAX_CHARS`, `languageForName` for `App.tsx`.

---

### 10. `app/src/util/mdInkFs.test.ts` (new)

**Before:** did not exist at base.

**After:** `app/src/util/mdInkFs.test.ts` (lines 14–93)

```ts
describe("docTypeForName", () => { /* markdown, pdf, epub, .py, .txt→code, unknown→code, Dockerfile */ });
describe("languageForName", () => { … });
describe("DOCUMENT_ACCEPT", () => { … });
describe("isTextDocType", () => { … });
describe("CODE_SOURCE_MAX_CHARS", () => { expect(…).toBe(1_500_000); });
```

**Behavior**

1. **Classification tests**
   - Locks in extension/basename rules and accept-string contents.

---

### 11. `app/src/util/mdInkStore.ts`

**Before:** https://github.com/amittenak47/lc-gui-tui/blob/cc36e932bfaab73e0b69ff03e57324816d4e2950/app/src/util/mdInkStore.ts

```ts
export type DocType = "markdown" | "pdf" | "epub";
/**
 * Markdown carries its source in the entry; PDF and EPUB keep their bytes …
 * across the three …
 */
```

**After:** `app/src/util/mdInkStore.ts` (lines 27–40, 64–71)

```ts
export type DocType = "markdown" | "pdf" | "epub" | "code";
/**
 * Markdown and code carry their source in the entry … across the four …
 */
/** The markdown or source text, so an entry can be reopened … */
```

**Behavior**

1. **Persistence model**
   - `code` is a text-backed type like markdown (`source` in localStorage entry).
   - `isBinaryDocType` unchanged (pdf/epub only).

---

### 12. `app/src/util/mdInkStore.test.ts`

**Before:** https://github.com/amittenak47/lc-gui-tui/blob/cc36e932bfaab73e0b69ff03e57324816d4e2950/app/src/util/mdInkStore.test.ts (no code-doc test; `saveMdInkDoc` block ended at library-full test)

**After:** `app/src/util/mdInkStore.test.ts` (lines 104–117)

```ts
it("stores code documents with docType code and their source text", () => {
  const saved = saveMdInkDoc({ name: "f.py", hash, docType: "code", source: "def f():\n  return 1\n", board: board("ink") });
  expect(loaded?.docType).toBe("code");
  expect(loaded?.source).toContain("def f()");
  expect(findMdInkDocByHash(hash)?.id).toBe(saved.id);
});
```

**Behavior**

1. **Library round-trip**
   - Code files save, reload, and hash-match like markdown entries.

---

## End-to-end behavior

1. **Open**
   - User picks a file → `docTypeForName` → text or bytes → optional size check → hash → library restore or fresh pad.

2. **Display**
   - `code` → `CodeDocument` with `languageForName(filename)`.
   - Annotate mode: source is decorative (`aria-hidden`); ink layer active.
   - Reading mode: text selectable; wide lines pan horizontally on `lc-code-doc-pre`.

3. **Persist**
   - Annotations keyed by content hash; full source text stored in library entry for code (same as markdown).

4. **Not in scope**
   - No syntax highlighting, no editing, no Monaco.
   - No migration of `MD_INK_*` id spelling.

## Verification

- `vitest` tests added/updated in `codeDocument.test.ts`, `mdInkFs.test.ts`, `mdInkStore.test.ts`, `scrollHost.test.ts`.
- Manual: open `.py` / `.rs` / `Makefile`, annotate, save, reopen from recent.
