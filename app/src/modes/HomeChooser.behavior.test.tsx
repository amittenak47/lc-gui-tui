/** @vitest-environment jsdom */
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {HomeChooser,type HomeChooserProps} from './HomeChooser';
import {initialTabState,type TabRecord} from '../util/tabs';
import {rememberRecentWorkspace,RECENT_WORKSPACES_EVENT} from '../util/recentWorkspaces';
let root:ReturnType<typeof createRoot>,host:HTMLDivElement;
beforeEach(()=>{
  const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener(){},removeEventListener(){}}));
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const entry:TabRecord={id:'old-pdf',kind:'annotate',title:'Earlier PDF',docId:null,docType:'pdf',hash:'earlier',source:null,indexed:'idle',dirty:false,lastActive:1};
function props():HomeChooserProps{return {onPractice:vi.fn(),onWhiteboard:vi.fn(),onAnnotate:vi.fn(),onBrowse:vi.fn(),onExplore:vi.fn(),onOpenRecent:vi.fn(),tabsRef:{current:initialTabState()}};}
it('opens a recent item through its callback, and removes it when it becomes an open tab',async()=>{
  rememberRecentWorkspace(entry);const p=props();await act(async()=>root.render(<HomeChooser {...p}/>));
  const recent=host.querySelector<HTMLButtonElement>('.lc-home-recent')!;
  await act(async()=>recent.click());expect(p.onOpenRecent).toHaveBeenCalledWith(expect.objectContaining({hash:'earlier',title:'Earlier PDF'}));
  p.tabsRef!.current.tabs.push({...entry,id:'new-tab'});
  await act(async()=>window.dispatchEvent(new Event(RECENT_WORKSPACES_EVENT)));
  expect(host.querySelector('.lc-home-recents')).not.toBeNull();
  expect(host.querySelectorAll('.lc-home-recent')).toHaveLength(0);
});
it('preserves all entry callbacks, including active WIP cards',async()=>{
  const p=props();await act(async()=>root.render(<HomeChooser {...p}/>));
  for(const [mode,handler] of [['practice',p.onPractice],['whiteboard',p.onWhiteboard],['annotate',p.onAnnotate],['browse',p.onBrowse],['explore',p.onExplore]] as const){
    const b=host.querySelector<HTMLButtonElement>(`.lc-home-card[data-mode="${mode}"]`);
    if(b){await act(async()=>b.click());expect(handler).toHaveBeenCalledOnce();}
  }
});
it('locks entry and recent buttons while busy and enables them when ready',async()=>{
  rememberRecentWorkspace(entry);const p=props();await act(async()=>root.render(<HomeChooser {...p} busy/>));
  expect([...host.querySelectorAll('button')].every(b=>b.disabled)).toBe(true);
  await act(async()=>root.render(<HomeChooser {...p}/>));
  expect([...host.querySelectorAll('button')].every(b=>!b.disabled)).toBe(true);
  expect(p.onAnnotate).not.toHaveBeenCalled();
  expect(host.querySelector('.lc-home-recent')).not.toBeNull();
});
it('stops the live illustration loops while Home is inactive',async()=>{
  const p=props();await act(async()=>root.render(<HomeChooser {...p}/>));expect(host.querySelectorAll('.lc-home-live-svg')).toHaveLength(2);
  await act(async()=>root.render(<HomeChooser {...p} active={false}/>));expect(host.querySelectorAll('.lc-home-live-svg')).toHaveLength(0);
});
