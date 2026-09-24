/** Keep the same position on a page when a preview's width changes. */
export interface PreviewPageBox { page:number;top:number;height:number }
export interface PreviewScrollAnchor { page:number;fraction:number }
export function previewScrollAnchor(pages:readonly PreviewPageBox[],top:number):PreviewScrollAnchor|null {
  const page=pages.find(p=>p.top+p.height>top)??pages.at(-1);
  return page && page.height>0 ? {page:page.page,fraction:(top-page.top)/page.height}:null;
}
export function previewScrollTop(pages:readonly PreviewPageBox[],anchor:PreviewScrollAnchor):number|null {
  const page=pages.find(p=>p.page===anchor.page);
  return page ? Math.max(0,page.top+anchor.fraction*page.height):null;
}
