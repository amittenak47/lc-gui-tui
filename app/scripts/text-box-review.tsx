// Isolated text regression page; never reads or writes a user's documents.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Board } from "../src/canvas/Board";
import type { BoardHandle } from "../src/canvas/BoardHandle";
import { ANNOTATE_REGION, annotatePageHeight, buildAnnotateTemplate } from "../src/templates/annotate";
import "../src/styles.css";
import { AnnotateDocument } from "../src/modes/AnnotateDocument";
import { DocSelectionLayer } from "../src/modes/DocSelectionLayer";
import { CodeDocument } from "../src/modes/CodeDocument";
import { WebDocument } from "../src/modes/WebDocument";
import { EpubDocument } from "../src/modes/EpubDocument";
import { PdfDocument } from "../src/modes/PdfDocument";
import { strToU8, zipSync } from "fflate";

const chapter = '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Eraser layer check</h1><p>Document content beneath the cursor.</p></body></html>';
const epub = zipSync({
  mimetype: strToU8("application/epub+zip"),
  "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="book.opf" /></rootfiles></container>'),
  "book.opf": strToU8('<package><metadata/><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" /></manifest><spine><itemref idref="chapter" /></spine></package>'),
  "chapter.xhtml": strToU8(chapter),
}).buffer as ArrayBuffer;
const stream = "BT /F1 24 Tf 60 700 Td (PDF eraser layer check) Tj ET";
const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
let pdf = "%PDF-1.4\n";
const offsets = objects.map((object, i) => { const offset = pdf.length; pdf += `${i+1} 0 obj\n${object}\nendobj\n`; return offset; });
const xref = pdf.length;
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => String(offset).padStart(10,"0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const pdfBytes = new TextEncoder().encode(pdf).buffer;
const longMarkdown = Array.from({ length: 100 }, (_, i) => `## Section ${i + 1}\n\n` + "Ink must stay with this paragraph while the document scrolls. ".repeat(15)).join("\n\n");

function Review() {
  const ref = useRef<BoardHandle>(null);
  const [format, setFormat] = useState("sample");
  const [paused, setPaused] = useState(false);
  const [height, setHeight] = useState(1400);
  const [annotating, setAnnotating] = useState(false);
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    Object.assign(window, {
      reviewClose: () => { Object.assign(window, { reviewReady: false }); setMounted(false); },
      reviewOpen: () => setMounted(true),
    });
  }, []);
  useEffect(() => {
    if (!mounted) return;
    const timer = setTimeout(async () => {
      const board = ref.current!;
      Object.assign(window, { reviewBoard: board, reviewDocument: setFormat, reviewPause: setPaused });
      board.seedTemplate(buildAnnotateTemplate(1400));
      await board.waitForTemplate();
      await board.settleFitView();
      Object.assign(window, { reviewReady: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [mounted]);
  const error = (message: string) => { throw new Error(message); };
  const content = format === "pdf" ? <PdfDocument bytes={pdfBytes} filmScope="text-box-review" frameWidth={760} onMeasure={setHeight} onError={error} />
    : format === "epub" ? <EpubDocument bytes={epub} onMeasure={setHeight} onError={error} />
    : format === "code" ? <CodeDocument source={'function example() {\n  return "Eraser layer check";\n}'} onMeasure={setHeight} />
    : format === "web" ? <WebDocument html={chapter} url="https://example.com" onMeasure={setHeight} />
    : format === "markdown" || format === "long-markdown" ? <AnnotateDocument source={format === "long-markdown" ? longMarkdown : '# Eraser layer check\n\nDocument content beneath the cursor.'} onMeasure={setHeight} selectable={!annotating} />
    : <><h2>Divisible subsequences</h2><p>Write your explanation below.</p></>;
  return mounted ? <Board ref={ref} splitPaused={paused} filmScope="text-box-review" themeId="graphite" mobileRegion={ANNOTATE_REGION} focusRegion={ANNOTATE_REGION}
    onAnnotateCodeChange={setAnnotating}
    pdfDocument={format === "pdf"}
    transparentCanvas docPaper selectableContent pageContentHeight={format !== "sample" ? annotatePageHeight(height) : 1400}
    pageContent={format !== "sample" ? <DocSelectionLayer enabled={!annotating} footnotes={[]}>
      {content}
    </DocSelectionLayer> : <div style={{ height: 1400, padding: 48, background: "white", color: "#222" }}>
      {content}
    </div>} /> : null;
}
const style = document.createElement("style");
style.textContent = "html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}.lc-board{width:100%;height:100%}";
document.head.append(style);
createRoot(document.getElementById("root")!).render(<Review />);
