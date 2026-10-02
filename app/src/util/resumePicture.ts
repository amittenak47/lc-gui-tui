/**
 * A picture of the page a tab was showing, for the moment it comes back.
 *
 * Only a few workspaces stay mounted; going back to one past that budget is
 * a full reopen of seconds, with nothing of the page on screen meanwhile. The
 * page turn already keeps a picture of the page at rest. Kept here per tab,
 * with where it sat in the tab, it is shown at once on the way back and the
 * live page fades in over it once it is ready.
 *
 * In memory, for this run of the app.
 */

export interface ResumePicture {
  canvas: HTMLCanvasElement;
  /** Where the page sat, in CSS px from the tab's top-left. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** The tab's size then: a picture from another size would sit wrong. */
  tabWidth: number;
  tabHeight: number;
  /** The paper behind it, so the margins match the board's. */
  paper: string;
}

const pictures = new Map<string, ResumePicture>();

export function keepResumePicture(tabId: string, picture: ResumePicture): void {
  pictures.set(tabId, picture);
}

/** The picture for this tab, if it fits a tab of this size. */
export function resumePictureFor(tabId: string, tabWidth: number, tabHeight: number): ResumePicture | null {
  const picture = pictures.get(tabId);
  if (!picture) return null;
  if (Math.abs(picture.tabWidth - tabWidth) > 2 || Math.abs(picture.tabHeight - tabHeight) > 2) return null;
  return picture;
}

export function dropResumePicture(tabId: string): void {
  pictures.delete(tabId);
}
