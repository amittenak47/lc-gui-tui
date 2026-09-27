// Isolated Chrome profile and Vite port; never reads the live app's storage.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const profile=resolve(`../.tmp-phase3-checks/split-ink-${process.pid}`);
await mkdir(profile,{recursive:true});
const port=1474,children=[];let socket;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
children.push(server);let errors='';server.stderr.on('data',data=>errors+=data);
try {
  let ready=false;
  for(let i=0;i<150;i++){
    if(server.exitCode!==null)throw new Error(errors||'Isolated Vite exited');
    try{const response=await fetch(`http://127.0.0.1:${port}/scripts/pinch-review.html`);if(response.ok){ready=true;break;}}catch{}
    await sleep(100);
  }
  assert(ready,'Isolated server did not start');
  const chrome=spawn(process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',[
    '--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking',`--user-data-dir=${profile}`,'--remote-debugging-port=0','about:blank'],{windowsHide:true,stdio:'ignore'});
  children.push(chrome);let debugPort;
  for(let i=0;i<100;i++){try{debugPort=(await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await sleep(100);}}
  assert(debugPort,'Chrome did not start');
  const tabs=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let seq=0;const pending=new Map(),exceptions=[];
  socket.onmessage=({data})=>{const message=JSON.parse(data);if(message.method==='Runtime.exceptionThrown'){exceptions.push(message.params);console.log('browser exception',JSON.stringify(message.params));}
    const task=pending.get(message.id);if(task){pending.delete(message.id);message.error?task.reject(message.error):task.resolve(message.result);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},120000);
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
  await send('Runtime.enable');await send('Performance.enable');

  await send('Emulation.setDeviceMetricsOverride',{width:1100,height:800,deviceScaleFactor:2,mobile:true});
  await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  await send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'});
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/`});await sleep(8000);

  await evaluate(`(async()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Continue without LLM'));if(b){b.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await new Promise(r=>setTimeout(r,2200));b.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true}));}})()`);
  await evaluate(`(async()=>{
    const {saveTabState}=await import('/src/util/tabPersist.ts');
    saveTabState({tabs:[{id:'home',kind:'home',title:'Home',dirty:false,lastActive:0},{id:'annotate-review',kind:'annotate',title:'Document.md',docId:null,hash:null,docType:'markdown',source:'# Document\\n\\nA document beside the writing canvas.\\n'.repeat(5),indexed:'idle',dirty:false,lastActive:2}],activeId:'annotate-review',groups:[]});
  })()`);
  await send('Page.reload');await sleep(16000);
  await evaluate(`(async()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Continue without LLM'));if(b){b.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await new Promise(r=>setTimeout(r,2200));b.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true}));}})()`);
  const hold=async label=>evaluate(`(async()=>{const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b)throw Error('Missing hold '+${JSON.stringify(label)});b.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await new Promise(r=>setTimeout(r,1100));b.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true}));})()`);
  await hold('Whiteboard: tap for a new notebook, hold to open the library');
  await hold('Hold to confirm: New');await sleep(14000);
  const whiteboardId=await evaluate(`document.querySelector('[data-tab-kind="whiteboard"]').getAttribute('data-tab-id')`);
  await evaluate(`document.querySelector('[data-tab-id="${whiteboardId}"] .lc-tab-hit').click()`);await sleep(400);
  await evaluate(`(()=>{
    const root=document.querySelector('[data-lc-tab="${whiteboardId}"] .lc-board');
    let f=root[Object.keys(root).find(k=>k.startsWith('__reactFiber'))];
    while(f){if(f.ref?.current?.getInkOpCount){window.splitBoard=f.ref.current;break;}f=f.return;}
    const toggle=document.querySelector('button[aria-label="Show toolbar"]');if(!toggle)throw Error('No toolbar toggle');toggle.click();
  })()`);await sleep(500);
  await evaluate(`window.splitBoard.setTool('freedraw')`);await sleep(200);

  const rects=await evaluate(`[...document.querySelectorAll('.lc-tab-hit')].filter(t=>t.closest('[data-tab-kind="whiteboard"], [data-tab-kind="annotate"]')).sort((a,b)=>Number(b.closest('[data-tab-kind="whiteboard"]')!==null)-Number(a.closest('[data-tab-kind="whiteboard"]')!==null)).map(t=>{const r=t.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})`);
  console.log('drag',rects);
  await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...rects[0],radiusX:5,radiusY:5,id:1}]});await sleep(700);
  for(let i=1;i<=20;i++){await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:rects[0].x+(rects[1].x-rects[0].x)*i/20,y:rects[1].y,radiusX:5,radiusY:5,id:1}]});await sleep(30);}
  await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(2500);
  console.log('after split',await evaluate(`JSON.stringify({dialogs:[...document.querySelectorAll('[role="dialog"]')].map(d=>d.getAttribute('aria-label')),boards:[...document.querySelectorAll('.lc-board')].map(b=>({class:b.className,parent:b.closest('.lc-canvas-wrap')?.className}))})`));
  const stroke=async label=>{
    const start=await evaluate(`(()=>{const root=document.querySelector('[data-lc-tab="${whiteboardId}"] .lc-board'),r=root.getBoundingClientRect();const x=r.x+r.width*.35,y=r.y+r.height*.4;return {before:window.splitBoard.getInkOpCount(),x,y,hit:document.elementFromPoint(x,y)?.className,ink:[...root.querySelectorAll('.lc-board-ink-lab-host,.lc-ink-lab-canvas')].map(c=>({class:c.className,rect:c.getBoundingClientRect().toJSON(),style:c.getAttribute('style'),pointer:getComputedStyle(c).pointerEvents,visibility:getComputedStyle(c).visibility}))};})()`);
    for(let i=0;i<=16;i++){
      await send('Input.dispatchMouseEvent',{type:i===0?'mousePressed':i===16?'mouseReleased':'mouseMoved',pointerType:'pen',button:'left',buttons:i===16?0:1,force:.5,x:start.x+i*5,y:start.y,clickCount:i===0||i===16?1:0});await sleep(12);
    }
    await sleep(500);
    const result=await evaluate(`({after:window.splitBoard.getInkOpCount(),class:document.querySelector('[data-lc-tab="${whiteboardId}"] .lc-board').className,dialogs:[...document.querySelectorAll('[role=dialog]')].map(d=>d.getAttribute('aria-label'))})`);
    console.log(label,JSON.stringify({...start,...result}));assert.equal(result.after,start.before+1,label+' did not draw');
  };
  const unexpected=await evaluate(`[...document.querySelectorAll('[role=dialog]')].map(d=>d.getAttribute('aria-label'))`);
  console.log('unexpected menu',unexpected);
  if(unexpected.length){
    await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:20,y:200,radiusX:5,radiusY:5,id:1}]});
    await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(500);
  }
  await stroke('after split and dismissal');
  await hold('Whiteboard: tap to save now, hold for save / load menu');
  await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:20,y:200,radiusX:5,radiusY:5,id:1}]});
  await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(500);
  await stroke('after intentional menu dismissal');
  await hold('Whiteboard: tap to save now, hold for save / load menu');
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim()==='Cancel').click()`);
  await stroke('after Cancel');
  const chip=await evaluate(`(()=>{const r=document.querySelector('[data-tab-id="${whiteboardId}"] .lc-tab-hit').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...chip,radiusX:5,radiusY:5,id:1}]});
  for(let i=1;i<=10;i++){await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:chip.x,y:chip.y+i*20,radiusX:5,radiusY:5,id:1}]});await sleep(30);}
  await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(1500);
  assert.equal(await evaluate(`document.querySelector('[data-tab-id="${whiteboardId}"]').getAttribute('data-tab-group')`),null,'Whiteboard should leave split');
  await stroke('after unsplitting');
  assert.equal(unexpected.length,0,'Splitting must not reopen the file menu');
  await writeFile(resolve(profile,'split.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  assert.equal(exceptions.length,0,JSON.stringify(exceptions));
  console.log(profile);
}finally{socket?.close();for(const child of children.reverse())child.kill();}
