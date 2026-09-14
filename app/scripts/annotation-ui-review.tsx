// Isolated browser regression harness; uses no saved documents or account.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Board } from "../src/canvas/Board";
import { AnnotateDocument } from "../src/modes/AnnotateDocument";
import { buildAnnotateTemplate, annotatePageHeight, ANNOTATE_REGION } from "../src/templates/annotate";
import { LoadingDoodle } from "../src/components/LoadingDoodle";
import "../src/styles.css";

function Review() {
  const ref = useRef<any>(null);
  const [height, setHeight] = useState(0);
  const [source, setSource] = useState("Loading document…");
  useEffect(() => {
    Object.assign(window, { reviewBoard: ref.current });
    // Reproduce opening at the template floor, before async Markdown arrives.
    const timer = setTimeout(async () => {
      if (!ref.current) return;
      ref.current.seedTemplate(buildAnnotateTemplate(1100));
      await ref.current.waitForTemplate();
      const file = new URLSearchParams(location.search).get("file");
      setSource(file ? await (await fetch(file)).text() : Array.from({ length: 160 }, (_, i) => `## Section ${i + 1}\n\n` +
        "A long Markdown document must scroll through every paragraph. ".repeat(12)).join("\n\n"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      ref.current.syncDocumentScrollBounds();
      await ref.current.settleFitView();
      Object.assign(window, { reviewReady: true });
    }, 500);
    return () => clearTimeout(timer);
  }, []);
  if (location.search.includes("doodle")) return <div style={{ position: "relative", width: "100vw", height: "100vh" }}><LoadingDoodle /></div>;
  return <Board ref={ref} filmScope="annotation-review" themeId="graphite"
    mobileRegion={ANNOTATE_REGION} focusRegion={ANNOTATE_REGION}
    transparentCanvas docPaper selectableContent
    pageContent={<AnnotateDocument source={source} onMeasure={setHeight} />}
    pageContentHeight={annotatePageHeight(height)} />;
}
const style = document.createElement("style");
style.textContent = "html,body,#root{margin:0;width:100%;height:100%;overflow:hidden} .lc-board{width:100%;height:100%}";
document.head.append(style);
createRoot(document.getElementById("root")!).render(<React.StrictMode><Review /></React.StrictMode>);
