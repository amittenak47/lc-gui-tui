import { afterEach, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { paintInkAtScale, type InkOp } from '../canvas/rasterInk';
import type { ConflictPaintRequest } from './conflictInkPaintPlan';

afterEach(()=>vi.unstubAllGlobals());
it('preserves ink coverage and erase order across DPR strip boundaries', async () => {
  const postMessage=vi.fn();
  const scope={onmessage:null as ((event: {data:ConflictPaintRequest})=>void)|null,postMessage};
  vi.stubGlobal('self',scope);
  vi.stubGlobal('OffscreenCanvas',class {
    constructor(width:number,height:number) {
      const canvas=createCanvas(width,height);
      return Object.assign(canvas,{transferToImageBitmap:()=>canvas});
    }
  });
  await import('./conflictInkPaint.worker');
  const draw = (color:string,x:number,y1:number,y2:number):InkOp => ({kind:'draw',color,baseWidth:5,maxFullness:1,
    pressureClip:1,pressureSensitive:true,boldness:1,speedBlotBlend:0,
    points:[{x,y:y1,pressure:0.5},{x:x+12,y:(y1+y2)/2,pressure:0.8},{x,y:y2,pressure:0.5}]});
  const ops:InkOp[]=[draw('#111111',40,10,990),
    {kind:'erase',radius:12,points:[{x:45,y:490,pressure:1},{x:45,y:540,pressure:1}]},
    draw('#2563eb',42,480,560),draw('#111111',90,800,940)];
  const expected=createCanvas(256,2048);
  paintInkAtScale(expected.getContext('2d') as unknown as CanvasRenderingContext2D,ops,{x:0,y:0},2);
  scope.onmessage!({data:{type:'pages',pages:[{page:1,ops,scale:1,originX:0,originY:0}]}});
  for(const offsetY of [0,512]) {
    scope.onmessage!({data:{type:'paint',job:{key:String(offsetY),page:1,width:128,height:512,offsetY,dpr:2}}});
    const bitmap=postMessage.mock.lastCall![0].bitmap as ReturnType<typeof createCanvas>;
    expect(bitmap).not.toBeNull();
    expect(bitmap.width).toBe(256);
    expect(bitmap.height).toBe(1024);
    const actual=bitmap.getContext('2d').getImageData(0,0,256,1024).data;
    const reference=expected.getContext('2d').getImageData(0,offsetY*2,256,1024).data;
    // Canvas clipping can slightly change antialiasing at curve edges. Compare
    // premultiplied coverage so transparent RGB and edge rounding are harmless.
    let error=0, coverage=0;
    for(let i=0;i<actual.length;i+=4) {
      const a=actual[i+3]/255, b=reference[i+3]/255;
      for(let channel=0;channel<3;channel++) error+=Math.abs(actual[i+channel]*a-reference[i+channel]*b);
      error+=Math.abs(actual[i+3]-reference[i+3]);
      coverage+=reference[i+3]+(reference[i]+reference[i+1]+reference[i+2])*b;
    }
    expect(error/coverage).toBeLessThan(0.005);
    expect(actual.some((value,index)=>index%4===3&&value>0)).toBe(true);
  }
});
