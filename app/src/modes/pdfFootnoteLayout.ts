import type { PageFrame } from "../canvas/inkPageIndex";
import type { DocAnchor } from "../util/docAnchors";
import type { DocFootnote } from "../util/docFootnotes";
import { pdfLayoutIsSpread } from "./pdfInkSpread";

type Band = { left: number; top: number; width: number; height: number };
type Placed = { band: Band; scope: string; frame: PageFrame };

/** Move saved page-local anchors and document-local bands together with PDF ink. */
export function remapPdfFootnotes(notes: readonly DocFootnote[], from: readonly PageFrame[], to: readonly PageFrame[], width: number): DocFootnote[] {
  const wasSpread = pdfLayoutIsSpread(from), spread = pdfLayoutIsSpread(to);
  if (wasSpread === spread || !(width > 0)) return notes.slice();
  const mapBand = (band: Band): Placed[] => {
    const result: Placed[] = [];
    for (const frame of from) {
      const top = Math.max(band.top, frame.minY), bottom = Math.min(band.top + band.height, frame.maxY);
      if (bottom <= top) continue;
      const before = from.filter(f => f.pageId === frame.pageId);
      const after = to.filter(f => f.pageId === frame.pageId);
      if (!after.length) continue;
      for (const half of (wasSpread ? [before.indexOf(frame)] : [0, 1])) {
        const left = Math.max(band.left, wasSpread ? 0 : half * width / 2);
        const right = Math.min(band.left + band.width, wasSpread ? width : (half + 1) * width / 2);
        if (right <= left) continue;
        const target = after[spread ? half : 0];
        if (!target) continue;
        const sx = spread ? 2 : .5;
        const sy = (target.maxY - target.minY) / (frame.maxY - frame.minY);
        result.push({scope:`p${frame.pageId}${spread && half === 1 ? "r" : ""}`,frame:target,band:{
          left: spread ? (left - half * width / 2) * sx : left * sx + half * width / 2,
          top: target.minY + (top - frame.minY) * sy,
          width:(right-left)*sx,height:(bottom-top)*sy,
        }});
      }
    }
    return result;
  };
  const remap = (anchor: DocAnchor, bands?: Band[]) => {
    const match = /^p(\d+)(r?)$/.exec(anchor.scope ?? "");
    if (!match) return { anchor, bands };
    const source = from.filter(f => f.pageId === Number(match[1]))[wasSpread && match[2] ? 1 : 0];
    if (!source) return { anchor, bands };
    const mapped = (bands ?? []).flatMap(mapBand);
    const region = anchor.kind === "region" ? mapBand({left:anchor.x,top:source.minY+anchor.y,width:anchor.w,height:anchor.h}) : [];
    const candidates = region.length ? region : mapped;
    const target = [...candidates].sort((a,b)=>b.band.width*b.band.height-a.band.width*a.band.height)[0];
    if (!target && anchor.kind === "region") return {anchor,bands};
    const scope = target?.scope ?? (spread ? anchor.scope : `p${match[1]}`);
    const nextAnchor: DocAnchor = anchor.kind === "region" && target
      ? {...anchor,scope,x:target.band.left,y:target.band.top-target.frame.minY,w:target.band.width,h:target.band.height}
      : {...anchor,scope};
    // A marquee spanning the gutter has two visible pieces. Retain both
    // even if the older mark had only its region rectangle, no stored bands.
    return {anchor:nextAnchor,bands:bands ? (mapped.length ? mapped.map(item=>item.band) : bands)
      : region.length > 1 ? region.map(item=>item.band) : undefined};
  };
  return notes.map(note => ({...note,...remap(note.anchor,note.bands),
    ...(note.subMarks ? {subMarks:note.subMarks.map(mark=>mark.anchor
      ? {...mark,...remap(mark.anchor,mark.bands)} as typeof mark
      : {...mark,bands:mark.bands?.flatMap(mapBand).map(item=>item.band)})} : {}),
  }));
}
