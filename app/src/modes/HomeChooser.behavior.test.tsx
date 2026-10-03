/** @vitest-environment jsdom */
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {HomeChooser,type HomeChooserProps} from './HomeChooser';
import {initialTabState,type TabRecord} from '../util/tabs';
import {loadRecentWorkspaces,rememberRecentWorkspace,RECENT_WORKSPACES_EVENT} from '../util/recentWorkspaces';
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
  expect(host.querySelector('.lc-home-recents')).toBeNull();
  expect(host.querySelectorAll('.lc-home-recent')).toHaveLength(0);
});
it('leaves no Recently opened section, and gives Start the full height, when nothing was opened',async()=>{
  const p=props();await act(async()=>root.render(<HomeChooser {...p}/>));
  expect(host.querySelector('.lc-home-recents')).toBeNull();
  expect(host.querySelector('nav')?.getAttribute('data-recents')).toBe('none');
  expect(host.textContent).not.toContain('Recently opened');
  expect(host.textContent).not.toContain('Start');
});
it('folds Recently opened to its heading, and remembers the choice',async()=>{
  rememberRecentWorkspace(entry);const p=props();await act(async()=>root.render(<HomeChooser {...p}/>));
  const toggle=host.querySelector<HTMLButtonElement>('.lc-home-recents-toggle')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('true');expect(toggle.textContent).toContain('1');
  expect(host.querySelectorAll('.lc-home-recent')).toHaveLength(1);
  expect([...host.querySelectorAll('h2')].map(h=>h.textContent)).toContain('Start');
  await act(async()=>toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelectorAll('.lc-home-recent')).toHaveLength(0);
  expect(host.querySelector('nav')?.getAttribute('data-recents')).toBe('collapsed');
  await act(async()=>root.unmount());root=createRoot(host);
  await act(async()=>root.render(<HomeChooser {...props()}/>));
  expect(host.querySelector('.lc-home-recents-toggle')?.getAttribute('aria-expanded')).toBe('false');
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
describe('hold to edit Recently opened',()=>{
  const second:TabRecord={...entry,id:'other-pdf',title:'Other PDF',hash:'other'};
  const press=(el:Element,type:string,x=10,y=10)=>el.dispatchEvent(new MouseEvent(type,{bubbles:true,clientX:x,clientY:y}));
  async function mountWithTwo(){
    rememberRecentWorkspace(entry);rememberRecentWorkspace(second);
    const p=props();await act(async()=>root.render(<HomeChooser {...p}/>));
    return p;
  }
  beforeEach(()=>vi.useFakeTimers());
  afterEach(()=>vi.useRealTimers());
  it('enters edit mode on a hold, and the release that ends it does not open the item',async()=>{
    const p=await mountWithTwo();
    const item=host.querySelector('.lc-home-recent')!;
    await act(async()=>{press(item,'pointerdown');vi.advanceTimersByTime(500);});
    expect(host.querySelector('.lc-home-recents')?.hasAttribute('data-editing')).toBe(true);
    expect(host.querySelectorAll('.lc-home-recent-remove')).toHaveLength(2);
    await act(async()=>{press(item,'pointerup');(item as HTMLButtonElement).click();});
    expect(p.onOpenRecent).not.toHaveBeenCalled();
    // While editing, a tap does not open either.
    await act(async()=>(item as HTMLButtonElement).click());
    expect(p.onOpenRecent).not.toHaveBeenCalled();
  });
  it('removes only from the list, and leaves the rest',async()=>{
    await mountWithTwo();
    await act(async()=>{press(host.querySelector('.lc-home-recent')!,'pointerdown');vi.advanceTimersByTime(500);});
    const remove=host.querySelector<HTMLButtonElement>('.lc-home-recent-remove')!;
    expect(remove.getAttribute('aria-label')).toMatch(/^Remove .+ from Recently opened$/);
    await act(async()=>remove.click());
    expect(host.querySelectorAll('.lc-home-recent')).toHaveLength(1);
    expect(loadRecentWorkspaces()).toHaveLength(1);
    // Still editing until told otherwise; removing the last one ends it.
    await act(async()=>host.querySelector<HTMLButtonElement>('.lc-home-recent-remove')!.click());
    expect(host.querySelector('.lc-home-recents')).toBeNull();
    expect(loadRecentWorkspaces()).toHaveLength(0);
  });
  it('treats a drag as scrolling the list, not a hold',async()=>{
    const p=await mountWithTwo();
    const item=host.querySelector('.lc-home-recent')!;
    await act(async()=>{press(item,'pointerdown',10,10);press(item,'pointermove',10,40);vi.advanceTimersByTime(600);});
    expect(host.querySelector('.lc-home-recents')?.hasAttribute('data-editing')).toBe(false);
    await act(async()=>{press(item,'pointerup',10,40);(item as HTMLButtonElement).click();});
    expect(p.onOpenRecent).toHaveBeenCalledOnce();
  });
  it('leaves edit mode with Done, Escape, or a tap outside the list',async()=>{
    await mountWithTwo();
    const hold=async()=>act(async()=>{press(host.querySelector('.lc-home-recent')!,'pointerdown');vi.advanceTimersByTime(500);press(host.querySelector('.lc-home-recent')!,'pointerup');});
    const editing=()=>host.querySelector('.lc-home-recents')?.hasAttribute('data-editing');
    await hold();expect(editing()).toBe(true);
    await act(async()=>host.querySelector<HTMLButtonElement>('.lc-home-recents-done')!.click());
    expect(editing()).toBe(false);
    await hold();expect(editing()).toBe(true);
    await act(async()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));});
    expect(editing()).toBe(false);
    await hold();expect(editing()).toBe(true);
    await act(async()=>press(host.querySelector('.lc-home-card')!,'pointerdown'));
    expect(editing()).toBe(false);
  });
  it('enters edit mode from the keyboard with Delete',async()=>{
    await mountWithTwo();
    const item=host.querySelector<HTMLButtonElement>('.lc-home-recent')!;
    await act(async()=>{item.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}));});
    expect(host.querySelectorAll('.lc-home-recent-remove')).toHaveLength(2);
  });
});
