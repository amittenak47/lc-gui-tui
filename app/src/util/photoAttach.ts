/**
 * Picking a photo for the coach composer, and getting it down to a payload.
 *
 * Same hidden-`<input type="file">` path as `mdInkFs` and the board's image
 * tool, for the same reason: it is the one picker that works in the desktop
 * WebView and on the tablet without a Rust dependency or a capability grant.
 * On Android that input already offers the gallery and the camera, so there is
 * no second "take a photo" entrance to build.
 *
 * Everything is re-encoded as PNG because that is the only thing the daemon's
 * `image_url` parts claim to carry (`data:image/png;base64,…`), and a JPEG
 * mislabelled as PNG is a provider-side decode error rather than an answer.
 * Re-encoding also gives somewhere honest to cap the size: a modern phone
 * camera is 4000px across and 4 MB, which is a slow upload of an image the
 * model will downscale anyway.
 */

/** Longest edge kept, in pixels. Comfortably above any model's image tiling. */
export const PHOTO_MAX_EDGE = 1568;

/** How many photos may ride along on one send. */
export const PHOTO_ATTACH_LIMIT = 4;

export const PHOTO_ACCEPT = "image/*";

export interface PickedPhoto {
  /** File name as picked, for the bubble caption. */
  name: string;
  /** Raw base64 PNG, no `data:` prefix — the shape `CoachAttachment` wants. */
  png: string;
}

/** Longest-edge clamp, preserving aspect and never scaling a small image up. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge = PHOTO_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) {
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`${file.name} is not an image this device can read`));
    };
    image.src = url;
  });
}

/** Decode, clamp the longest edge, re-encode as base64 PNG. */
export async function photoFromFile(file: File): Promise<PickedPhoto> {
  const image = await loadImage(file);
  const { width, height } = fitWithin(
    image.naturalWidth || image.width,
    image.naturalHeight || image.height,
  );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this device cannot re-encode the image");
  ctx.drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("this device cannot re-encode the image");
  return { name: file.name || "Photo", png: dataUrl.slice(comma + 1) };
}

/**
 * Ask for one or more images and normalise them.
 *
 * Resolves `[]` when the picker is dismissed — see the note in `mdInkFs` about
 * why cancel resolves rather than rejects, and why the input is off-screen
 * rather than `display: none`.
 */
export function pickPhotos(limit = PHOTO_ATTACH_LIMIT): Promise<PickedPhoto[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = PHOTO_ACCEPT;
    input.multiple = limit > 1;
    input.style.position = "fixed";
    input.style.left = "-10000px";
    input.style.opacity = "0";

    let settled = false;
    const finish = (value: PickedPhoto[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener("cancel", () => finish([]));
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []).slice(0, limit);
      if (files.length === 0) {
        finish([]);
        return;
      }
      Promise.all(files.map((file) => photoFromFile(file)))
        .then(finish)
        .catch((cause) => {
          if (settled) return;
          settled = true;
          input.remove();
          reject(cause);
        });
    });

    document.body.append(input);
    input.click();
  });
}
