/** Editor coordinates stay fixed while the board camera scales the whole page. */
export const CODE_PAGE_WIDTH = 1200;
export const CODE_PAGE_INSET = 8;
export const CODE_PAGE_HEADER = 36;
export const CODE_TAB_HEIGHT = 32;
export function codePageGeometry(frameWidth: number) {
  const sceneScale = Math.max(1, frameWidth) / CODE_PAGE_WIDTH;
  return {sceneScale, inset: CODE_PAGE_INSET * sceneScale,
    header: CODE_PAGE_HEADER * sceneScale,
    width: (CODE_PAGE_WIDTH - CODE_PAGE_INSET * 2) * sceneScale};
}
