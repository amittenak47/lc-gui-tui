import {useLayoutEffect,useRef} from "react";

/** Animate the measured dialog box while preserving one scroll/focus surface. */
export function useLibraryMorph(view:string) {
 const ref=useRef<HTMLDivElement>(null), previous=useRef<number|null>(null), animation=useRef<Animation|null>(null);
 useLayoutEffect(()=>{
  const node=ref.current;if(!node)return;
  const from=animation.current ? node.getBoundingClientRect().height : previous.current;
  animation.current?.cancel();
  const to=node.getBoundingClientRect().height;
  previous.current=to;
  if(from===null || !node.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)return;
  animation.current=node.animate([{height:`${from}px`},{height:`${to}px`}],{duration:280,easing:"cubic-bezier(.22,1,.36,1)"});
  const current=animation.current;
  current.onfinish=()=>{if(animation.current===current)animation.current=null;};
  node.querySelector<HTMLElement>(".lc-settings-body")?.animate([{opacity:.35,transform:"translateY(6px)"},{opacity:1,transform:"translateY(0)"}],{duration:240,easing:"ease-out"});
 },[view]);
 useLayoutEffect(()=>()=>animation.current?.cancel(),[]);
 return ref;
}
