export function selectionCaptureFrame(bounds: { left: number; top: number; width: number; height: number }, view: { offsetLeft: number; offsetTop: number; scrollX: number; scrollY: number; zoom: number }) {
  if (bounds.width < 1 || bounds.height < 1 || view.zoom <= 0) throw new Error("Selection has no capture bounds");
  return {
    x: (bounds.left - view.offsetLeft) / view.zoom - view.scrollX,
    y: (bounds.top - view.offsetTop) / view.zoom - view.scrollY,
    width: bounds.width / view.zoom, height: bounds.height / view.zoom,
  };
}
