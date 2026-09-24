/** @vitest-environment jsdom */
import { act, useLayoutEffect, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConflictPagePreview } from './ConflictPagePreview';
import type { InkOp } from '../canvas/rasterInk';

const raster = vi.hoisted(() => ({ paint: vi.fn(), dispose: vi.fn(), pages: vi.fn(), loadPdf: () => {} }));
vi.mock('./conflictInkPaint', async () => ({
  ...await vi.importActual('./conflictInkPaintPlan'),
  ConflictInkPainter: class { constructor(pages: unknown) { raster.pages(pages); } paint = raster.paint; dispose = raster.dispose; },
}));
vi.mock('../modes/PdfDocument', async () => ({ ...await vi.importActual('../modes/PdfDocument'), PdfDocument: ({onMeasure}: {onMeasure: (height: number) => void}) => {
  const [loaded, setLoaded] = useState(false);
  raster.loadPdf = () => setLoaded(true);
  useLayoutEffect(() => { if (loaded) onMeasure(1200); }, [loaded, onMeasure]);
  return loaded ? <div data-pdf-page="1" /> : null;
} }));
vi.mock('../modes/AnnotateDocument', () => ({ AnnotateDocument: ({onMeasure}: {onMeasure: (height: number) => void}) => {
  useLayoutEffect(() => { onMeasure(1200); }, [onMeasure]);
  return <div>Long document</div>;
} }));
vi.mock('../modes/DocSelectionLayer', () => ({ DocSelectionLayer: ({children}: {children: ReactNode}) => children }));
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
  raster.pages.mockClear();
  raster.paint.mockReset().mockImplementation(() => new Promise(resolve => paintPending.push(() => resolve(document.createElement('canvas')))));
  host = document.createElement('div'); document.body.append(host); root=createRoot(host);
});

it('places ink when PDF slots arrive after the ink decode', async () => {
  const bytes = new ArrayBuffer(10);
  act(() => root.render(<ConflictPagePreview {...props} decodedInk={shards} hash="test" filmScope="test" bytes={bytes} />));
  expect(raster.paint).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Loading preview"]')).not.toBeNull();
  act(() => raster.loadPdf());
  expect(raster.paint).toHaveBeenCalled();
  await act(async () => { paintPending.forEach(finish => finish()); });
  expect(host.querySelector('[aria-label="Preview ready"]')).not.toBeNull();
  expect(host.querySelector('canvas')?.width).toBe(800);
});

it('paints Markdown ink over the authored document width', async () => {
  act(() => root.render(<ConflictPagePreview {...props} sceneWidth={800} sourceText="# Long document" decodedInk={shards} />));
  await act(async () => { paintPending.forEach(finish => finish()); });
  expect(host.querySelector('canvas')?.width).toBe(800);
  expect(host.querySelector<HTMLElement>('[data-pdf-page] > div')?.style.transform).toBe('scale(0.5)');
  expect(host.querySelector('[aria-label="Preview ready"]')).not.toBeNull();
});

it('reveals faint ink without modifying stored strokes', () => {
  const faint = [{pageId:1,ops:ops.map(op=>({...op,color:'#fff',maxFullness:.01,baseWidth:.2}))}];
  act(()=>root.render(<ConflictPagePreview {...props} decodedInk={faint} revealInk />));
  const sent=raster.pages.mock.calls.at(-1)![0][0].ops[0];
  expect(sent.color).toBe('#00e5ff');expect(sent.maxFullness).toBe(1);expect(sent.baseWidth).toBeGreaterThanOrEqual(3);
  expect(faint[0].ops[0].baseWidth).toBe(.2);
});

it('sends only nearby pages to the ink worker on a long notebook', () => {
  const pages = Array.from({length: 100}, (_, i) => ({pageId: i + 1, minY: i * 1200, maxY: (i + 1) * 1200}));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const top = (Number(this.dataset.pdfPage || 1) - 1) * 1200;
    return {x:0,y:top,top,left:0,right:400,bottom:top+1200,width:400,height:1200,toJSON(){}};
  });
  act(() => root.render(<ConflictPagePreview {...props} pageFrames={pages} decodedInk={pages.map(p => ({pageId: p.pageId, ops: ops.map(op => ({...op, points: op.points.map(point => ({...point, y: point.y + p.minY}))}))}))} />));
  const sent = raster.pages.mock.calls.at(-1)![0];
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.length).toBeLessThanOrEqual(2);
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

it('shows rules only when the saved overlay mode is on', () => {
  act(()=>root.render(<ConflictPagePreview {...props} showInk={false} linedPitchPair={{wide:100,college:80}} />));
  const paper = () => host.querySelector<HTMLElement>('.lc-hub-conflict-lined')!;
  expect(paper().style.backgroundImage).toBe('none');
  act(()=>root.render(<ConflictPagePreview {...props} showInk={false} linedPitchPair={{wide:100,college:80}} linedPaperMode="college" linedRule="college" />));
  expect(paper().style.backgroundImage).not.toBe('none');
  expect(paper().style.backgroundSize).toContain('80px');
  act(()=>root.render(<ConflictPagePreview {...props} showInk={false} linedPitchPair={{wide:100,college:80}} linedPaperMode="off" />));
  expect(paper().style.backgroundImage).toBe('none');
});
