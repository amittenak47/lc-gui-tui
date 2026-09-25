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
 it("uses an immediate curve under reduced motion",()=>{
  const rope=stepEdgeRope(a,b,undefined,0);
  expect(stepEdgeRope(a,{x:400,y:120},rope,1,true).points[4].y).toBe(60);
 });
});
