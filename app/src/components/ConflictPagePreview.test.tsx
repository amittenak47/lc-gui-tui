/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConflictPagePreview } from './ConflictPagePreview';
import type { InkOp } from '../canvas/rasterInk';

const raster = vi.hoisted(() => ({ paint: vi.fn(), dispose: vi.fn() }));
vi.mock('./conflictInkPaint', async () => ({
  ...await vi.importActual('./conflictInkPaintPlan'),
  ConflictInkPainter: class { paint = raster.paint; dispose = raster.dispose; },
}));
vi.mock('../modes/PdfDocument', () => ({ PdfDocument: () => null }));
vi.mock('../modes/AnnotateDocument', () => ({ AnnotateDocument: () => null }));
vi.mock('../modes/DocSelectionLayer', () => ({ DocSelectionLayer: () => null }));
let root: Root;
let host: HTMLDivElement;
let paintPending: Array<() => void>;
const ops: InkOp[] = [{kind:'draw', color:'#111', baseWidth:4, maxFullness:1, pressureClip:1, pressureSensitive:false,
  points:[{x:20,y:20,pressure:-1},{x:40,y:800,pressure:-1}]}];
const frames = [{pageId:1,minY:0,maxY:1200}];
const shards = [{pageId:1,ops}];
const empty: typeof shards = [];
const props = {page:1, pageCount:1, showInk:true, sceneWidth:400, pageFrames:frames};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('devicePixelRatio', 2);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const height = this.hasAttribute('data-pdf-page') ? 1200 : 600;
    return {x:0,y:0,top:0,left:0,right:400,bottom:height,width:400,height,toJSON(){}};
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage:vi.fn()} as unknown as CanvasRenderingContext2D);
  paintPending = [];
  raster.paint.mockReset().mockImplementation(() => new Promise(resolve => paintPending.push(() => resolve(document.createElement('canvas')))));
  host = document.createElement('div'); document.body.append(host); root=createRoot(host);
});
afterEach(() => {act(()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});

it('keeps the loading spinner until the newly decoded visible ink is painted', async () => {
  act(()=>root.render(<ConflictPagePreview {...props} decodedInk={empty} inkLoading />));
  expect(host.querySelector('[aria-label="Loading preview"]')).not.toBeNull();
  act(()=>root.render(<ConflictPagePreview {...props} decodedInk={shards} inkLoading={false} />));
  expect(raster.paint).toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Loading preview"]')).not.toBeNull();
  // The indicator is outside the scrolling paper, so flicking cannot scroll it away.
  expect(host.querySelector('.lc-hub-conflict-preview .lc-hub-conflict-load')).toBeNull();
  await act(async()=>{paintPending.forEach(finish=>finish());});
  expect(host.querySelector('[aria-label="Preview ready"]')).not.toBeNull();
  expect(host.querySelector('canvas')?.width).toBe(800);
});

it('dims existing canvases for Drop without scheduling more paint', async () => {
  act(()=>root.render(<ConflictPagePreview {...props} decodedInk={shards} />));
  await act(async()=>{paintPending.forEach(finish=>finish());});
  const calls = raster.paint.mock.calls.length;
  const canvas = host.querySelector('canvas');
  act(()=>root.render(<ConflictPagePreview {...props} decodedInk={shards} droppedPages={[1]} />));
  expect(host.querySelector('canvas')).toBe(canvas);
  expect(canvas?.style.opacity).toBe('0.38');
  expect(raster.paint).toHaveBeenCalledTimes(calls);
});
