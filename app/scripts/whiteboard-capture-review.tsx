import {useEffect,useRef} from "react";
import {createRoot} from "react-dom/client";
import {Board} from "../src/canvas/Board";
import type {BoardHandle} from "../src/canvas/BoardHandle";
import {buildWhiteboardTemplate} from "../src/templates/whiteboard";
import {encodeInkOps} from "../src/canvas/inkCodec";
import type {InkOp} from "../src/canvas/rasterInk";
import "../src/styles.css";
function Review(){
 const ref=useRef<BoardHandle>(null);
 useEffect(()=>{void(async()=>{
  await new Promise(r=>setTimeout(r,500));const board=ref.current!;
  board.seedTemplate(buildWhiteboardTemplate(2,false));await board.waitForTemplate();
  const ops:InkOp[]=Array.from({length:20},(_,i)=>({kind:"draw",color:"#e00000",baseWidth:8,pressureSensitive:false,
   points:Array.from({length:50},(_,j)=>({x:200+j*30,y:300+i*200+Math.sin(j/3)*30,pressure:.5}))}));
  board.ingestInkPages(new Map([[1,encodeInkOps(ops)]]));await board.settleFitView();await board.primeInkSnap();
  Object.assign(window,{reviewBoard:board,reviewReady:true});
 })();},[]);
 return <Board ref={ref} themeId="paper" mobileRegion="pad-0" focusRegion="pad-0"/>;
}
const style=document.createElement("style");style.textContent="html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}.lc-board{width:100%;height:100%}";document.head.append(style);
createRoot(document.querySelector("#root")!).render(<Review/>);
