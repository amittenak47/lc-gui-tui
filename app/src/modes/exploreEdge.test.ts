import {describe,it,expect} from "vitest";
import {stepEdgeBow,edgeBowPath,edgeBowDepth,MAX_BOW,type EdgeBow,type EdgePoint} from "./exploreEdge";
const a={x:0,y:0},b={x:400,y:0};
const run=(bow:EdgeBow,end:(t:number)=>EdgePoint,from:number,to:number,each?:(t:number)=>void)=>{
  for(let i=from;i<=to;i++){const t=i/60;stepEdgeBow(a,end(t),bow,t);each?.(t);}
};
/** Point on the drawn quadratic at its parameter midpoint: the bow's peak. */
const peak=(from:EdgePoint,to:EdgePoint,bow:EdgeBow)=>{
  const [,cx,cy]=/Q(-?[\d.]+) (-?[\d.]+)/.exec(edgeBowPath(from,to,bow))!.map(Number);
  return {x:(from.x+2*cx+to.x)/4,y:(from.y+2*cy+to.y)/4};
};
describe("drag-driven graph edges",()=>{
 it("rests straight without an idle ripple",()=>{
  const bow=stepEdgeBow(a,b,undefined,0),before=edgeBowPath(a,b,bow);
  run(bow,()=>b,1,120);
  expect(edgeBowPath(a,b,bow)).toBe(before);
  expect(edgeBowDepth(a,b,bow)).toBe(0);
 });
 it("pins both ends to the nodes",()=>{
  const bow=stepEdgeBow(a,b,undefined,0),end={x:400,y:120};
  stepEdgeBow(a,end,bow,1/60);
  expect(edgeBowPath(a,end,bow)).toMatch(/^M0\.0 0\.0 Q.* 400\.0 120\.0$/);
 });
 it("bends at the middle of the edge, not next to the dragged node",()=>{
  const bow=stepEdgeBow(a,b,undefined,0),end=(t:number)=>({x:400,y:600*t});
  run(bow,end,1,12,(t)=>{
   const to=end(t),p=peak(a,to,bow);
   // The peak projects onto the middle of the edge, so the bow is symmetric.
   const along=(p.x*to.x+p.y*to.y)/(to.x**2+to.y**2);
   expect(along).toBeCloseTo(.5,2);
  });
  expect(Math.abs(edgeBowDepth(a,end(.2),bow))).toBeGreaterThan(5);
 });
 it("never hangs slack while an end is swept about hard",()=>{
  const bow=stepEdgeBow(a,b,undefined,0);let deepest=0;
  const end=(t:number)=>({x:400+300*Math.sin(t*9),y:500*Math.sin(t*7)});
  run(bow,end,1,180,(t)=>{
   const to=end(t),len=Math.hypot(to.x,to.y);
   deepest=Math.max(deepest,Math.abs(edgeBowDepth(a,to,bow))/len);
  });
  expect(deepest).toBeLessThanOrEqual(MAX_BOW+1e-9);
 });
 it("springs back past the line once after a drop, then settles straight",()=>{
  // Dragged down at a steady pace for half a second, then let go.
  const bow=stepEdgeBow(a,b,undefined,0),dropped={x:400,y:240};
  run(bow,(t)=>({x:400,y:480*t}),1,30);
  const held=edgeBowDepth(a,dropped,bow);
  // Count only swings a person could see (over half a pixel).
  let crossings=0,last=Math.sign(held);
  run(bow,()=>dropped,31,300,()=>{
   const d=edgeBowDepth(a,dropped,bow);if(Math.abs(d)<.5)return;
   const s=Math.sign(d);if(s!==last)crossings++;last=s;
  });
  expect(Math.abs(held)).toBeGreaterThan(5);
  expect(crossings).toBe(1);
  expect(Math.abs(edgeBowDepth(a,dropped,bow))).toBeLessThan(.05);
 });
 it("draws straight at once under reduced motion",()=>{
  const bow=stepEdgeBow(a,b,undefined,0);
  expect(edgeBowDepth(a,{x:400,y:120},stepEdgeBow(a,{x:400,y:120},bow,1,true))).toBe(0);
 });
});
