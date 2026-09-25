import {useEffect,useRef,useState} from "react";
import {createRoot} from "react-dom/client";
import {Board} from "../src/canvas/Board";
import type {BoardHandle,ScreenRect} from "../src/canvas/BoardHandle";
import {buildProblemTemplate} from "../src/templates/problemBoard";
import {PseudocodeEditor} from "../src/modes/PseudocodeEditor";
import {StatementDocument} from "../src/modes/StatementDocument";
import "../src/styles.css";
function Review(){
 const ref=useRef<BoardHandle>(null),[slot,setSlot]=useState<ScreenRect|null>(null),[page,setPage]=useState<"code"|"constraints">("code"),[height,setHeight]=useState<number|null>(null);
 const [source,setSource]=useState("from typing import List\n\nclass Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        seen = {}\n        for index, value in enumerate(nums):\n            if target - value in seen:\n                return [seen[target - value], index]\n            seen[value] = index\n"+"\n".repeat(35));
 useEffect(()=>{void(async()=>{
  await new Promise(r=>setTimeout(r,600));const board=ref.current!;
  board.seedTemplate(buildProblemTemplate({taskId:"review",title:"Two sum"}));await board.waitForTemplate();
  await board.settleFitView(); Object.assign(window,{reviewBoard:board,reviewReady:true,setReviewPage:setPage});
 })();},[]);
 return <div className="lc-canvas-wrap"><Board ref={ref} themeId="paper" mobileRegion={page} focusRegion={page} onCodeSlot={setSlot} codeContentHeight={height}
 pageContent={page==="constraints" ? <StatementDocument title="Two sum" description={"Find two numbers that add to the target. ".repeat(70)}/> : null}/>
 {slot && page==="code" && <div className="lc-code-dock" style={{left:slot.left,top:slot.top,width:slot.width/slot.zoom,height:slot.height/slot.zoom,transform:`scale(${slot.zoom})`,transformOrigin:"top left"}}><PseudocodeEditor value={source} onChange={setSource} themeId="paper" variant="dock" zoom={1} onCodeHeight={h=>setHeight(h*(slot.sceneScale??1))}/></div>}
 </div>;
}
const style=document.createElement("style");style.textContent="html,body,#root,.lc-canvas-wrap{margin:0;width:100%;height:100%;overflow:hidden;position:relative}.lc-board{width:100%;height:100%}";document.head.append(style);
createRoot(document.querySelector("#root")!).render(<Review/>);
