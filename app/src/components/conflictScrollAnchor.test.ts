import { expect,it } from "vitest";
import { previewScrollAnchor,previewScrollTop } from "./conflictScrollAnchor";
it("keeps page 50 and the position within it as the window widens",()=>{
  const pages=(height:number)=>Array.from({length:100},(_,i)=>({page:i+1,top:18+i*(height+18),height}));
  const narrow=pages(400),wide=pages(1200);
  const anchor=previewScrollAnchor(narrow,narrow[49].top+100)!;
  expect(anchor).toEqual({page:50,fraction:.25});
  expect(previewScrollTop(wide,anchor)).toBe(wide[49].top+300);
  expect(previewScrollTop(narrow,previewScrollAnchor(wide,wide[49].top+300)!)).toBe(narrow[49].top+100);
});
