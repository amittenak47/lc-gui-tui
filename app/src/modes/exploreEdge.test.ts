import {describe,it,expect} from "vitest";
import {looseEdgePath,edgePhase} from "./exploreEdge";
const a={x:10,y:20,vx:0,vy:0},b={x:400,y:150,vx:0,vy:0};
describe("loose graph edges",()=>{
 it("changes shape with still nodes while preserving endpoints",()=>{
  const first=looseEdgePath(a,b,edgePhase("a"),0,.4),later=looseEdgePath(a,b,edgePhase("a"),1,.4);
  expect(first).not.toBe(later);
  for(const path of [first,later]){expect(path.startsWith("M10.0 20.0")).toBe(true);expect(path.endsWith("400.0 150.0")).toBe(true);expect(path.match(/ C/g)).toHaveLength(8);}
 });
 it("is stable at a fixed time for reduced motion",()=>{
  expect(looseEdgePath(a,b,edgePhase("b"),0,.4)).toBe(looseEdgePath(a,b,edgePhase("b"),0,.4));
  expect(edgePhase("a")).not.toBe(edgePhase("b"));
 });
 it("handles overlapping endpoints without invalid coordinates",()=>{
  expect(looseEdgePath(a,a,0,4,0)).toBe("M10 20 L10 20");
 });
});
