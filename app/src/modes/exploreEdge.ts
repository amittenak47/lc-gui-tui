export interface EdgePoint {x:number;y:number}
/** One sprung control point that trails the edge's midpoint. */
export interface EdgeBow {x:number;y:number;vx:number;vy:number;time:number}

// A taut bow, not a rope: the edge bends as one arc whose peak sits at its
// middle, however hard an end is dragged. ~2.9 Hz, a little under critical
// damping, so a release springs past the line once and settles.
const STIFFNESS=324,DAMPING=19.8;
/** Deepest bow, as a fraction of the edge's length, so it never hangs slack. */
export const MAX_BOW=0.14;

/** The control point chases the midpoint; how far it lags is the bow. */
export function stepEdgeBow(from:EdgePoint,to:EdgePoint,previous:EdgeBow|undefined,time:number,reduced=false):EdgeBow {
  const mx=(from.x+to.x)/2,my=(from.y+to.y)/2;
  if(!previous||reduced)return {x:mx,y:my,vx:0,vy:0,time};
  const elapsed=Math.max(0,Math.min(.05,time-previous.time));
  const steps=Math.max(1,Math.ceil(elapsed*120)),dt=elapsed/steps;
  for(let step=0;step<steps;step++){
    previous.vx+=(STIFFNESS*(mx-previous.x)-DAMPING*previous.vx)*dt;
    previous.vy+=(STIFFNESS*(my-previous.y)-DAMPING*previous.vy)*dt;
    previous.x+=previous.vx*dt;previous.y+=previous.vy*dt;
  }
  previous.time=time;return previous;
}

/** How far the edge's middle sits off the straight line, across the edge only. */
export function edgeBowDepth(from:EdgePoint,to:EdgePoint,bow:EdgeBow):number {
  const dx=to.x-from.x,dy=to.y-from.y,len=Math.hypot(dx,dy);
  if(len<1e-6)return 0;
  const across=((bow.x-(from.x+to.x)/2)*-dy+(bow.y-(from.y+to.y)/2)*dx)/len;
  const cap=MAX_BOW*len;
  return Math.max(-cap,Math.min(cap,across));
}

/** A quadratic whose peak is the bow: the control sits at twice the depth. */
export function edgeBowPath(from:EdgePoint,to:EdgePoint,bow:EdgeBow):string {
  const fmt=(p:EdgePoint)=>`${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  const dx=to.x-from.x,dy=to.y-from.y,len=Math.hypot(dx,dy);
  const depth=edgeBowDepth(from,to,bow);
  const control=len<1e-6?from:{x:(from.x+to.x)/2-dy/len*depth*2,y:(from.y+to.y)/2+dx/len*depth*2};
  return `M${fmt(from)} Q${fmt(control)} ${fmt(to)}`;
}
