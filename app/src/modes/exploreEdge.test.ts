import {describe,it,expect} from "vitest";
import {stepEdgeRope,edgeRopePath} from "./exploreEdge";
const a={x:0,y:0},b={x:400,y:0};
describe("drag-driven graph edges",()=>{
 it("rests without an idle ripple",()=>{
  const rope=stepEdgeRope(a,b,undefined,0),before=edgeRopePath(rope);
  for(let i=1;i<120;i++)stepEdgeRope(a,b,rope,i/60);
  expect(edgeRopePath(rope)).toBe(before);
 });
 it("trails either drag direction with pinned endpoints",()=>{
  for(const direction of [-1,1]){
   const rope=stepEdgeRope(a,b,undefined,0),end={x:400,y:120*direction};
   stepEdgeRope(a,end,rope,1/60);
   expect(rope.points[8]).toMatchObject(end);
   expect(rope.points[0]).toMatchObject(a);
   expect(rope.points[4].y*direction).toBeLessThan(60);
   expect(edgeRopePath(rope).match(/ C/g)).toHaveLength(8);
  }
 });
 it("settles after release and reverses its bend when dragging back",()=>{
  const rope=stepEdgeRope(a,b,undefined,0),end={x:400,y:120};
  for(let i=1;i<=240;i++)stepEdgeRope(a,end,rope,i/60);
  expect(rope.points[4].y).toBeCloseTo(60,1);
  stepEdgeRope(a,b,rope,241/60);
  expect(rope.points[4].y).toBeGreaterThan(40);
  for(let i=242;i<480;i++)stepEdgeRope(a,b,rope,i/60);
  expect(rope.points[4].y).toBeCloseTo(0,1);
 });
 it("bows as one arc, not a wiggle, while an end is swept about",()=>{
  const rope=stepEdgeRope(a,b,undefined,0);let kinked=0;
  for(let i=1;i<=180;i++){
   const t=i/60;stepEdgeRope(a,{x:400+60*Math.sin(t*5),y:150*Math.sin(t*3.3)},rope,t);
   const bend=rope.points.slice(1,8).map((p,j)=>rope.points[j].y+rope.points[j+2].y-2*p.y);
   if(bend.some((c,j)=>j>0&&Math.abs(c)>.3&&Math.abs(bend[j-1])>.3&&Math.sign(c)!==Math.sign(bend[j-1])))kinked++;
  }
  expect(kinked/180).toBeLessThan(.05);
 });
 it("springs back past the line once, then settles",()=>{
  const rope=stepEdgeRope(a,b,undefined,0),end={x:400,y:120};let past=0;
  for(let i=1;i<=240;i++){stepEdgeRope(a,end,rope,i/60);past=Math.max(past,rope.points[4].y-60);}
  expect(past).toBeGreaterThan(5);
  expect(past).toBeLessThan(25);
  expect(rope.points[4].y).toBeCloseTo(60,1);
 });
 it("uses an immediate curve under reduced motion",()=>{
  const rope=stepEdgeRope(a,b,undefined,0);
  expect(stepEdgeRope(a,{x:400,y:120},rope,1,true).points[4].y).toBe(60);
 });
});
