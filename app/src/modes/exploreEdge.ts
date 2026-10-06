export interface EdgePoint {x:number;y:number}
interface RopePoint extends EdgePoint {vx:number;vy:number}
export interface EdgeRope {points:RopePoint[];time:number}

// Bend resists kinks, so the rope bows as one arc. Inner damping slows points
// relative to their neighbours: wiggles die while the bow keeps one bounce.
const ANCHOR=90,TENSION=260,BEND=300,DAMP=6,INNER_DAMP=30;

/** Interior points retain momentum; moving an endpoint pulls the curve behind it. */
export function stepEdgeRope(from:EdgePoint,to:EdgePoint,previous:EdgeRope|undefined,time:number,reduced=false):EdgeRope {
  const target=(i:number)=>({x:from.x+(to.x-from.x)*i/8,y:from.y+(to.y-from.y)*i/8});
  if(!previous||reduced)return {points:Array.from({length:9},(_,i)=>({...target(i),vx:0,vy:0})),time};
  const points=previous.points;
  Object.assign(points[0],from,{vx:0,vy:0});Object.assign(points[8],to,{vx:0,vy:0});
  const elapsed=Math.max(0,Math.min(.05,time-previous.time));
  const steps=Math.max(1,Math.ceil(elapsed*120)),dt=elapsed/steps;
  // Past an end, mirror the next point through it: the end is a hinge.
  const at=(i:number):EdgePoint=>i<0?{x:2*points[0].x-points[1].x,y:2*points[0].y-points[1].y}
    :i>8?{x:2*points[8].x-points[7].x,y:2*points[8].y-points[7].y}:points[i];
  for(let step=0;step<steps;step++){
    const forces=points.map((p,i)=>{
      if(i===0||i===8)return {x:0,y:0};
      const aim=target(i),a=points[i-1],b=points[i+1],a2=at(i-2),b2=at(i+2);
      return {x:ANCHOR*(aim.x-p.x)+TENSION*(a.x+b.x-2*p.x)-BEND*(a2.x-4*a.x+6*p.x-4*b.x+b2.x)-DAMP*p.vx+INNER_DAMP*(a.vx+b.vx-2*p.vx),
        y:ANCHOR*(aim.y-p.y)+TENSION*(a.y+b.y-2*p.y)-BEND*(a2.y-4*a.y+6*p.y-4*b.y+b2.y)-DAMP*p.vy+INNER_DAMP*(a.vy+b.vy-2*p.vy)};
    });
    for(let i=1;i<8;i++){
      const p=points[i];p.vx+=forces[i].x*dt;p.vy+=forces[i].y*dt;p.x+=p.vx*dt;p.y+=p.vy*dt;
    }
  }
  previous.time=time;return previous;
}

export function edgeRopePath(rope:EdgeRope):string {
  const points=rope.points;
  const fmt=(p:EdgePoint)=>`${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  let path=`M${fmt(points[0])}`;
  for(let i=0;i<points.length-1;i++){
    const a=points[Math.max(0,i-1)],b=points[i],c=points[i+1],d=points[Math.min(points.length-1,i+2)];
    path+=` C${fmt({x:b.x+(c.x-a.x)/6,y:b.y+(c.y-a.y)/6})} ${fmt({x:c.x-(d.x-b.x)/6,y:c.y-(d.y-b.y)/6})} ${fmt(c)}`;
  }
  return path;
}
