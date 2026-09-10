import type { PaintSceneElement, PaintSceneFile } from "./paintScene";

/** Decode only images used by this scene. Failed files do not block the board. */
export async function loadSceneImages(
  elements: readonly PaintSceneElement[],
  files: Record<string, PaintSceneFile | undefined>,
): Promise<Record<string, CanvasImageSource>> {
  const images: Record<string, CanvasImageSource> = {};
  const ids = new Set(elements.filter((el) => el.type === "image" && !el.isDeleted).map((el) => el.fileId));
  await Promise.all([...ids].map(async (id) => {
    const url = id ? files[id]?.dataURL : undefined;
    if (!id || !url) return;
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
      images[id] = img;
    } catch { /* Missing or corrupt photos leave the rest of the scene intact. */ }
  }));
  return images;
}
