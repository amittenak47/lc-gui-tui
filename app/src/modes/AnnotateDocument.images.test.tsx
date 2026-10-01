/** @vitest-environment jsdom */
import { expect, it } from "vitest";

import { renderMarkdown } from "./AnnotateDocument";

it("keeps pictures written into a note, PNG and SVG alike", () => {
  const html = renderMarkdown(
    "![plot](data:image/png;base64,iVBORw0KGgo=)\n\n![diagram](data:image/svg+xml;base64,PHN2Zy8+)",
  );
  expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  expect(html).toContain('src="data:image/svg+xml;base64,PHN2Zy8+"');
});
