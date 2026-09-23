/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HubConflictSplit } from './HubConflictSplit';
import type { HubPadConflict } from '../util/hubConflictStash';

const decode = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown[]>>(() => new Promise(() => {})));
const preview = vi.hoisted(() => ({observe: (_pages: readonly number[]) => {}}));
vi.mock('./conflictInkLayout', async () => ({
  ...await vi.importActual('./conflictInkLayout'), decodeConflictInkPages: decode,
}));
vi.mock('./ConflictPagePreview', () => ({ConflictPagePreview: (props: {onVisiblePages: typeof preview.observe}) => { preview.observe = props.onVisiblePages; return null; }}));

it('loads newly visible PDF ink without requiring a row click', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const body={id:'pdf',name:'Book',hash:'h',doc_type:'pdf',updated_at:1,board:null,agent:[],footnotes:[]};
  const conflict={kind:'annotate',id:'pdf',stage:'ink',detail:'both changed',local:body,server:body} as HubPadConflict;
  const fetchPreviewInk=vi.fn(async (_pageId: number) => ({local:[],server:[]}));
  try {
    await act(async()=>root.render(<HubConflictSplit conflict={conflict} onResolve={()=>{}} fetchPreviewInk={fetchPreviewInk}/>));
    fetchPreviewInk.mockClear();
    await act(async()=>preview.observe([40,41]));
    expect(fetchPreviewInk.mock.calls.map(call=>call[0])).toEqual([40,41]);
    await act(async()=>preview.observe([40,41]));
    expect(fetchPreviewInk).toHaveBeenCalledTimes(2);
  } finally {act(()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

it('resolves PDF spanning ink by its stored shard, never invented sheet IDs', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const ops=[{kind:'erase',radius:2,points:[{x:10,y:30,pressure:1},{x:10,y:1500,pressure:1}]}];
  decode.mockResolvedValue([{pageId:0,ops}]);
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const body={id:'pdf',name:'Book',hash:'h',doc_type:'pdf',updated_at:1,board:null,agent:[],footnotes:[]};
  const conflict={kind:'annotate',id:'pdf',stage:'ink',detail:'both changed',local:body,server:body,
    localInkStamps:[{pageId:0,updatedAt:1}],hubInkStamps:[{pageId:0,updatedAt:2}]} as HubPadConflict;
  const resolve=vi.fn();
  try {
    await act(async()=>root.render(<HubConflictSplit conflict={conflict} onResolve={resolve} pageFrames={[{pageId:1,minY:0,maxY:1000},{pageId:2,minY:1018,maxY:2018}]}/>));
    act(()=>{
      const panes=host.querySelectorAll('.lc-hub-conflict-pane');
      (panes[0].querySelector('.lc-hub-conflict-pane-head [data-action="keep"]') as HTMLButtonElement).click();
      (panes[1].querySelector('.lc-hub-conflict-pane-head [data-action="keep"]') as HTMLButtonElement).click();
    });
    act(()=>(host.querySelector('.lc-hub-conflict-resolve') as HTMLButtonElement).click());
    expect(resolve.mock.calls[0][0].inkPages).toEqual([{pageId:0,choice:'merged'}]);
  } finally {act(()=>root.unmount());host.remove();vi.unstubAllGlobals();decode.mockReset().mockImplementation(()=>new Promise(()=>{}));}
});

it('keeps selection feedback immediate during loading and does not restart for equivalent workspace frames', () => {
  decode.mockClear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const body = {id:'w1',title:'Exam 1',page_count:1,updated_at:1,board:null,agent:[]};
  const conflict = {kind:'whiteboard',id:'w1',stage:'ink',detail:'both changed',local:body,server:body,
    localInkPageIds:[1],hubInkPageIds:[1],localInkStamps:[{pageId:1,updatedAt:1}],hubInkStamps:[{pageId:1,updatedAt:2}]} as HubPadConflict;
  const render = () => root.render(<HubConflictSplit conflict={conflict} onResolve={()=>{}}
    pageFrames={[{pageId:1,minY:0,maxY:4200}]} />);
  try {
    act(render);
    const initialCalls = decode.mock.calls.length;
    expect(initialCalls).toBe(2);
    act(()=>{(host.querySelector('.lc-hub-conflict-ink [data-action="keep"]') as HTMLButtonElement).click();});
    expect(host.querySelector('.lc-hub-conflict-ink')?.getAttribute('data-pick')).toBe('keep');
    expect(host.querySelectorAll('.lc-hub-conflict-ink')[1]?.getAttribute('data-pick')).toBe('drop');
    act(render);
    act(render);
    expect(decode).toHaveBeenCalledTimes(initialCalls);
    expect(host.querySelector('.lc-hub-conflict-ink')?.getAttribute('data-pick')).toBe('keep');
  } finally {act(()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
