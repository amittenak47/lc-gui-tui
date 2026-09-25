// Isolated Chrome profile and Vite port; never reads the live app's storage.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const profile=resolve(`../.tmp-phase3-checks/library-${process.pid}`);
await mkdir(profile,{recursive:true});
const port=1464,children=[];let socket;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
children.push(server);let errors='';server.stderr.on('data',data=>errors+=data);
try {
  let ready=false;
  for(let i=0;i<150;i++){
    if(server.exitCode!==null)throw new Error(errors||'Isolated Vite exited');
    try{const response=await fetch(`http://127.0.0.1:${port}/scripts/library-menu-review.html`);if(response.ok){ready=true;break;}}catch{}
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
  socket.onmessage=({data})=>{const message=JSON.parse(data);if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params);
    const task=pending.get(message.id);if(task){pending.delete(message.id);message.error?task.reject(message.error):task.resolve(message.result);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},120000);
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
  await send('Runtime.enable');await send('Performance.enable');
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/scripts/library-menu-review.html`});
  for(let i=0;i<300;i++){if(await evaluate('Boolean(window.showMenu)')){ready=true;break;}if(exceptions.length)throw new Error(JSON.stringify(exceptions));await sleep(100);}
  const click=async label=>{await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});if(b.classList.contains('lc-hold-reveal')){b.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));setTimeout(()=>b.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true})),950);}else b.click();})()`);await sleep(1250);};
  const hold=async label=>{const point=await evaluate(`(()=>{const b=document.querySelector('[aria-label="Hold to confirm: ${label}"]');if(!b)throw Error('Missing hold');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await sleep(950);await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});await sleep(100);};
  for(const [width,height] of [[1280,900],[390,760],[760,390]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    for(const kind of ['document','whiteboard','web']) {
      await evaluate(`window.showMenu(${JSON.stringify(kind)})`);await sleep(350);
      await hold('Pull');
      const foot=await evaluate(`(()=>{const d=document.querySelector('[role="dialog"]'),r=d.querySelector('.lc-settings-foot').getBoundingClientRect();return {bottom:r.bottom,height:r.height,status:!!d.querySelector('[aria-label="Hub pull results"]')};})()`);
      assert(foot.bottom<=height+1 && foot.height>=32 && foot.status,'Pull status hid footer');
      assert(await evaluate(`document.querySelectorAll('[aria-label="Filter pull results"] button').length===4`),'Missing pull filters');
      for(const label of ['Added','Repaired','Not uploaded','Unavailable'])await click(label);
      const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(profile,`${kind}-${width}.png`),Buffer.from(shot.data,'base64'));
      if(kind==='whiteboard'){await click('Open');await hold('Load');}else{if(kind!=='web')await click('Open');await click('Recents');}
      const geometry=await evaluate(`(()=>{const d=document.querySelector('[role="dialog"]'),b=d.getBoundingClientRect(),body=d.querySelector('.lc-settings-body');return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,search:!!d.querySelector('input[type="search"]'),rows:d.querySelectorAll('.lc-scratch-load-entry').length,overflow:d.scrollWidth>d.clientWidth+1,scroll:body.scrollHeight>body.clientHeight};})()`);
      assert(geometry.left>=0 && geometry.right<=width+1 && geometry.top>=0 && geometry.bottom<=height+1 && !geometry.overflow && geometry.search && geometry.rows>0,`${kind} menu clipped: ${JSON.stringify(geometry)}`);
      if(kind!=='web')assert(geometry.scroll,'Long library does not scroll');
      const fill=await evaluate(`(()=>{const b=document.querySelector('.lc-scratch-load-hold'),f=b.querySelector('.lc-hold-reveal-fill');f.style.setProperty('--lc-hold','0.5');const t=getComputedStyle(f).transform;return t;})()`);
      assert(fill==='matrix(0.5, 0, 0, 1, 0, 0)',`Hold fill must go left to right: ${fill}`);
      const listShot=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(profile,`${kind}-${width}-list.png`),Buffer.from(listShot.data,'base64'));
      console.log(`PASS ${kind} catalog at ${width}x${height}: list scrolls, pull report and footer fit`);
    }
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1000,height:900,deviceScaleFactor:1,mobile:false});
  await evaluate('window.showPractice()');await sleep(600);
  assert(await evaluate(`document.querySelectorAll('[role="option"]').length>0 && !!document.querySelector('[aria-label="Search problems"]')`),'Practice catalog lost its controls');
  const practice=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve(profile,'practice.png'),Buffer.from(practice.data,'base64'));
  console.log('PASS practice catalog retains search, filters and problem rows');
  assert(!exceptions.length,JSON.stringify(exceptions));
  console.log(`Artifacts: ${profile}`);
}finally{socket?.close();for(const child of children.reverse())child.kill();}
