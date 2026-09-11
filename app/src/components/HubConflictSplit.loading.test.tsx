/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HubConflictSplit } from './HubConflictSplit';
import type { HubPadConflict } from '../util/hubConflictStash';

const decode = vi.hoisted(() => vi.fn(() => new Promise(() => {})));
vi.mock('./conflictInkLayout', async () => ({
  ...await vi.importActual('./conflictInkLayout'), decodeConflictInkPages: decode,
}));
vi.mock('./ConflictPagePreview', () => ({ConflictPagePreview: () => null}));

it('keeps selection feedback immediate during loading and does not restart for equivalent workspace frames', () => {
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
