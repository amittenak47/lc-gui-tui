import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentSidePanel, type AgentChatMessage } from "../src/modes/AgentSidePanel";
import { Board } from "../src/canvas/Board";
import { AnnotateDocument } from "../src/modes/AnnotateDocument";
import { PdfDocument } from "../src/modes/PdfDocument";
import { ANNOTATE_REGION, annotatePageHeight, buildAnnotateTemplate } from "../src/templates/annotate";
import { deferPanelRefit } from "../src/util/splitResize";
import "../src/styles.css";
import { buildWhiteboardTemplate } from "../src/templates/whiteboard";
import { PageTurn } from "../src/canvas/pageTurn/PageTurn";
const whiteboard = new URLSearchParams(location.search).has("whiteboard");
const messages: AgentChatMessage[] = [{id:"q",role:"user",content:"Explain this document",sessionId:"session-q"}, ...Array.from({length:60},(_,i)=>({id:`a${i}`,role:"assistant" as const,content:"A lengthy answer with **Markdown** and $x^2$. ".repeat(8),sessionId:"session-q"}))];
const source = Array.from({length:100},(_,i)=>`## Section ${i+1}\n\n` + "Panel motion must not refit this long document before painting. ".repeat(15)).join("\n\n");
import { reviewPdf } from "./reviewPdf";
const pdfBytes=new URLSearchParams(location.search).has("pdf") ? reviewPdf() : null;
function Review(){
  const [open,setOpen]=useState(false), [height,setHeight]=useState(0), [ready,setReady]=useState(false);
  const board=useRef<any>(null), previous=useRef(open);
  Object.assign(window,{setReviewOpen:setOpen});
  useLayoutEffect(()=>{
    if(previous.current===open)return;
    previous.current=open;
    if(innerWidth<=900)return;
    return deferPanelRefit();
  },[open]);
  useEffect(()=>{
    const timer=setTimeout(async()=>{
      board.current.seedTemplate(whiteboard ? buildWhiteboardTemplate() : buildAnnotateTemplate(1100));
      await board.current.waitForTemplate();
      board.current.syncDocumentScrollBounds();
      await board.current.settleFitView();
      await new Promise(r=>setTimeout(r,1200));
      const b=board.current;
      if(!whiteboard){
        const page=b.readingPageFrames()[2]; b.setPageLock(page);b.setPageFit(.94);b.jumpToPageFrame(page);
      }
      const view=b.getViewportBounds();
      b.setInkOps([{kind:"draw",color:"#e00000",baseWidth:8,pressureSensitive:false,points:[
        {x:view.x+view.width*.3,y:view.y+view.height*.3,pressure:.5},
        {x:view.x+view.width*.6,y:view.y+view.height*.6,pressure:.5}
      ]}]);
      setReady(true);
      Object.assign(window,{reviewReady:true,reviewBoard:b});
    },500);
    return ()=>clearTimeout(timer);
  },[]);
  return <div style={{"--lc-agent-width":"1100px"} as any} className={`lc-app ${innerWidth<=900?"lc-mobile":""} ${open?"lc-app-agent-open":""}`}><header className="lc-header">Home</header><main className="lc-main">
    <Board ref={board} filmScope="agent-motion-review" themeId="graphite" mobileRegion={whiteboard ? "pad-0" : ANNOTATE_REGION}
      focusRegion={whiteboard ? "pad-0" : ANNOTATE_REGION} transparentCanvas docPaper selectableContent
      pageContent={whiteboard ? undefined : pdfBytes ? <PdfDocument filmScope="agent-motion-review" bytes={pdfBytes} frameWidth={1100} onMeasure={setHeight}/> : <AnnotateDocument source={source} onMeasure={setHeight}/>}
      pageContentHeight={whiteboard ? undefined : annotatePageHeight(height)}/>
      {!whiteboard && ready && <PageTurn boardRef={board} filmScope="agent-motion-review" hostSelector=".lc-main" lockActive turnEnabled spread={false} paged={!!pdfBytes} fit={.94}/>}
    </main><AgentSidePanel open={open} onOpenChange={setOpen} mode="review" onModeChange={()=>{}} busy={false} messages={messages} onSend={()=>{}} /></div>
}
createRoot(document.getElementById("root")!).render(<Review/>);
