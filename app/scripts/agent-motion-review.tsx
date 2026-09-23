import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentSidePanel, type AgentChatMessage } from "../src/modes/AgentSidePanel";
import "../src/styles.css";
const messages: AgentChatMessage[] = [{id:"q",role:"user",content:"Explain this document",sessionId:"session-q"}, ...Array.from({length:60},(_,i)=>({id:`a${i}`,role:"assistant" as const,content:"A lengthy answer with **Markdown** and $x^2$. ".repeat(8),sessionId:"session-q"}))];
function Review(){const [open,setOpen]=useState(false); Object.assign(window,{setReviewOpen:setOpen});
return <div className={`lc-app ${innerWidth<=900?"lc-mobile":""} ${open?"lc-app-agent-open":""}`}><header className="lc-header">Home</header><main className="lc-main"><p>Document remains stable.</p></main><AgentSidePanel open={open} onOpenChange={setOpen} mode="review" onModeChange={()=>{}} busy={false} messages={messages} onSend={()=>{}} /></div>}
createRoot(document.getElementById("root")!).render(<Review/>);
