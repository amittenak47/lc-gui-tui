// Isolated browser fixture: no daemon, accounts, or user notebooks.
import { useEffect, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Board } from "../src/canvas/Board";
import { AnnotateDocument } from "../src/modes/AnnotateDocument";
import { TabStrip } from "../src/components/TabStrip";
import { initialTabState, tabsReducer, type TabState } from "../src/util/tabs";
import { ColorSlotEditor } from "../src/canvas/ColorSlotEditor";
import { NotificationStack } from "../src/components/NotificationStack";
import { AgentSidePanel, type AgentChatMessage } from "../src/modes/AgentSidePanel";
import { DocumentDrawingPanel } from "../src/viz/DocumentDrawingPanel";
import { parseVizProgram } from "../src/viz/schema";
import { installSafeAreaInsets } from "../src/util/safeArea";
import { ANNOTATE_REGION, annotatePageHeight, buildAnnotateTemplate } from "../src/templates/annotate";
import "../src/styles.css";

const source = Array.from({length:100},(_,i)=>`## Section ${i+1}\n\n` + "Long documents should scroll after ink and sync. ".repeat(15)).join("\n\n");
function Review() {
  const board = useRef<any>(null);
  const [height,setHeight] = useState(0);
  const [editor,setEditor] = useState(false);
  const [agent,setAgent] = useState(false);
  const [showing, setShowing] = useState(true);
  const [mounted, setMounted] = useState(true);
  const [tabsVisible, setTabsVisible] = useState(false);
  const [, setRevision] = useState(0);
  useEffect(() => {
    Object.assign(window, {
      reviewRerender: () => setRevision(n => n + 1),
      reviewSetShowing: setShowing,
      reviewClose: () => setMounted(false),
      reviewShowTabs: () => setTabsVisible(true),
    });
  }, []);
  useEffect(() => {
    Object.assign(window,{reviewBoard:board.current,reviewShowEditor:()=>setEditor(true),reviewShowAgent:()=>{setEditor(false);setAgent(true);}});
    const timer=setTimeout(async()=>{
      board.current.seedTemplate(buildAnnotateTemplate(1100));
      await board.current.waitForTemplate();
      board.current.syncDocumentScrollBounds();
      await board.current.settleFitView();
      Object.assign(window,{reviewReady:true});
    },500);
    return ()=>clearTimeout(timer);
  },[]);
  return <>
    <header className="lc-header" style={{height:38,minHeight:38}}>{tabsVisible ? <TabReview /> : "⌂ Home"}</header>
    <NotificationStack />
    <div style={{position:"relative",height:"calc(100% - 38px)", display: showing ? undefined : "none"}}>
      {mounted && <Board ref={board} filmScope="sync-review" themeId="graphite" mobileRegion={ANNOTATE_REGION}
        splitPaused={!showing}
        focusRegion={ANNOTATE_REGION} transparentCanvas docPaper selectableContent
        pageContent={<AnnotateDocument source={source} onMeasure={setHeight}/>}
        pageContentHeight={annotatePageHeight(height)}/>}
    </div>
    {editor && <ColorSlotEditor color="#b88662" anchor={{x:24,y:1080}} zIndex={270}
      onConfirm={()=>setEditor(false)} onDiscard={()=>setEditor(false)} />}
    {agent && <AgentReview />}
  </>;
}
function TabReview() {
  const [state, dispatch] = useReducer(tabsReducer, null, (): TabState => ({
    ...initialTabState(), activeId: "review-a",
    tabs: [...initialTabState().tabs, ...["a", "b", "c", "d"].map(id => ({
      id: `review-${id}`, kind: "whiteboard" as const, title: `Notebook ${id.toUpperCase()}`,
      dirty: false, lastActive: 0, notebookId: id,
    }))],
  }));
  return <TabStrip tabs={state.tabs} groups={state.groups} activeId={state.activeId}
    onFocus={id => dispatch({type:"focus",id,at:Date.now()})}
    onClose={id => dispatch({type:"close",id})}
    onReorder={(id,targetId,side) => dispatch({type:"reorder",id,targetId,side})}
    onUnsplit={id => dispatch({type:"unsplit",id})}
    onTabDropOnTab={(id,targetId) => {
      if (state.groups.some(group => group.children.includes(id) && group.children.includes(targetId))) {
        dispatch({type:"swap-split",id});
      } else dispatch({type:"split",a:targetId,b:id,axis:"vertical",at:Date.now()});
    }} />;
}
function AgentReview() {
  useEffect(() => installSafeAreaInsets(), []);
  const [open,setOpen] = useState(true);
  const [messages,setMessages] = useState<AgentChatMessage[]>(() => [
    {id:"first",role:"user",content:"Explain this formula"},
    ...Array.from({length:18},(_,i)=>({id:`m${i}`,role:"assistant" as const,content:`**Step ${i}** uses $x^2$ and a clear paragraph.\n\n$$\\sum_{i=1}^n i$$`})),
    {id:"reply",role:"assistant",content:"A threaded answer.",replyTo:{id:"first",role:"user",excerpt:"Explain this formula"}},
    {id:"draw",role:"assistant",content:"Walk along the array.",drawing:{program:parseVizProgram({id:"walk",viz:"array",title:"A small array walk",frames:[{label:"Start",cells:[1,2,3],pointers:{i:0}},{label:"Next",cells:[1,2,3],pointers:{i:1}}]})!,expanded:true,frameIndex:0}},
  ]);
  const onFrame=(id:string,frame:number)=>setMessages(current=>current.map(m=>m.drawing?.program.id===id?{...m,drawing:{...m.drawing,frameIndex:frame}}:m));
  const onToggle=(id:string,expanded:boolean)=>setMessages(current=>current.map(m=>m.id===id&&m.drawing?{...m,drawing:{...m.drawing,expanded}}:m));
  useEffect(() => {
    Object.assign(window, {
      reviewBeginAgentTurn: () => setMessages(current => [...current,
        {id:"motion-user",role:"user",at:Date.now(),content:"Explain the sum using a short animated drawing.",flags:["Ask","Reasoning · high","Draw"]},
        {id:"motion-agent",role:"assistant",at:Date.now(),content:"",pending:true,pendingAck:{flags:["Ask","Reasoning · high","Draw"],hasQuestion:true,boardAttached:false,photoCount:0}},
      ]),
      reviewCompleteAgentTurn: () => setMessages(current => current.map(message => message.id === "motion-agent"
        ? {...message,pending:false,flags:message.pendingAck?.flags,content:"The **sum** is $1+2+3=6$.\n\nEach frame visits the next cell and adds its value to the running total."}
        : message)),
    });
  }, []);
  return <div className={`lc-app lc-mobile ${open?"lc-app-agent-open":""}`} style={{zIndex:500}}>
    <header className="lc-header">⌂ Home</header>
    <main className="lc-main" style={{position:"relative",flex:1,background:"var(--bg)"}}>
      <p style={{padding:24}}>A document with its own drawing viewer.</p>
      <DocumentDrawingPanel messages={messages} onFrame={onFrame} onHide={onToggle}/>
    </main>
    <AgentSidePanel open={open} onOpenChange={setOpen} mode="review" onModeChange={()=>{}} busy={false}
      messages={messages} agentSurface="pad" onSend={()=>{}} onDrawingFrame={onFrame} onToggleDrawing={onToggle}/>
  </div>;
}
const style=document.createElement("style");
style.textContent="html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}.lc-board{width:100%;height:100%}";
document.head.append(style);
createRoot(document.getElementById("root")!).render(<Review/>);
