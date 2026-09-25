import {sagOf} from "./exploreLayout";

export interface EdgePoint {x:number;y:number;vx:number;vy:number}

/** A small, smooth rope with pinned ends. Time is seconds, shared by the frame. */
export function looseEdgePath(from:EdgePoint,to:EdgePoint,phase:number,time:number,normalizedLength:number):string {
  const dx=to.x-from.x,dy=to.y-from.y,length=Math.hypot(dx,dy);
  if(length<.01)return `M${from.x} ${from.y} L${to.x} ${to.y}`;
  const nx=-dy/length,ny=dx/length;
  const amplitude=Math.min(48,length*sagOf(normalizedLength)*.8);
  const push=(v:EdgePoint)=>Math.max(-24,Math.min(24,(v.vx*nx+v.vy*ny)*.12));
  const startPush=push(from),endPush=push(to);
  const points=Array.from({length:9},(_,i)=>{
    const u=i/8,envelope=Math.sin(Math.PI*u);
    const ripple=Math.sin(u*Math.PI*4-time*1.3+phase)*.7
      +Math.sin(u*Math.PI*2+time*.83+phase*1.7)*.5;
    const offset=envelope*(amplitude*ripple+startPush*(1-u)+endPush*u);
    return {x:from.x+dx*u+nx*offset,y:from.y+dy*u+ny*offset};
  });
  // Catmull-Rom to cubic Beziers: continuous tangents through each bend.
  const fmt=(p:{x:number;y:number})=>`${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  let path=`M${fmt(from)}`;
  for(let i=0;i<points.length-1;i++){
    const a=points[Math.max(0,i-1)],b=points[i],c=points[i+1],d=points[Math.min(points.length-1,i+2)];
    path+=` C${fmt({x:b.x+(c.x-a.x)/6,y:b.y+(c.y-a.y)/6})} ${fmt({x:c.x-(d.x-b.x)/6,y:c.y-(d.y-b.y)/6})} ${fmt(c)}`;
  }
  return path;
}

export function edgePhase(id:string):number {
  let hash=2166136261;
  for(let i=0;i<id.length;i++)hash=Math.imul(hash^id.charCodeAt(i),16777619)>>>0;
  return hash/0xffffffff*Math.PI*2;
}
