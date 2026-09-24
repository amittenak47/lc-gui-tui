import { useEffect,useRef,useState } from "react";
import { createRoot } from "react-dom/client";
import { Board } from "../src/canvas/Board";
import type { BoardHandle } from "../src/canvas/BoardHandle";
import { PdfDocument } from "../src/modes/PdfDocument";
import { DocSelectionLayer } from "../src/modes/DocSelectionLayer";
import { buildAnnotateTemplate,annotatePageHeight,ANNOTATE_REGION } from "../src/templates/annotate";
import { encodeInkOps } from "../src/canvas/inkCodec";
import { reviewPdf } from "./reviewPdf";
import "../src/styles.css";
const bytes=reviewPdf(),width=1100,pageHeight=Math.round(width*800/600),page=50,top=18+(page-1)*(pageHeight+18);
const notes=[{id:"n",kind:"note" as const,createdAt:1,excerpt:"Resize target",anchor:{kind:"region" as const,scope:`p${page}`,x:60,y:80,w:450,h:50},bands:[{left:60,top:top+80,width:450,height:50}]}];
function Review(){
  const ref=useRef<BoardHandle>(null),[height,setHeight]=useState(0),[marks,setMarks]=useState<HTMLElement|null>(null);
  useEffect(()=>{let gone=false;void(async()=>{
    await new Promise(r=>setTimeout(r,500));if(gone)return;
    const board=ref.current!;board.seedTemplate(buildAnnotateTemplate(annotatePageHeight(null),false,width));await board.waitForTemplate();
    for(let i=0;i<100 && document.querySelectorAll('[data-pdf-page]').length<100;i++)await new Promise(r=>setTimeout(r,100));
    board.ingestInkPages(new Map([[50,encodeInkOps([
      {kind:"draw",baseWidth:8,color:"#e00000",pressureSensitive:false,points:[{x:60,y:top+160,pressure:.5},{x:500,y:top+160,pressure:.5}]},
      {kind:"draw",baseWidth:30,color:"#ffff00",highlight:true,highlightTips:false,points:[{x:60,y:top+100,pressure:.5},{x:500,y:top+100,pressure:.5}]},
    ])]]));
    board.syncDocumentScrollBounds();await board.settleFitView();board.scrollToPdfPage(50);
    Object.assign(window,{reviewBoard:board,reviewReady:true});
  })();return()=>{gone=true;};},[]);
  return <Board ref={ref} filmScope="resize-reader" themeId="graphite" mobileRegion={ANNOTATE_REGION} focusRegion={ANNOTATE_REGION}
    transparentCanvas docPaper selectableContent onMarksSlot={setMarks}
    pageContent={<DocSelectionLayer enabled marksHost={marks} paletteScope="resize-reader" footnotes={notes}><PdfDocument bytes={bytes} docHash="resize-pdf" filmScope="resize-reader" frameWidth={width} onMeasure={setHeight} idleThumbs={false}/></DocSelectionLayer>}
    pageContentHeight={annotatePageHeight(height)}/>;
}
const style=document.createElement('style');style.textContent='html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}.lc-board{width:100%;height:100%}';document.head.append(style);
createRoot(document.querySelector('#root')!).render(<Review/>);
