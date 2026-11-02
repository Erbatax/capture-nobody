import type { Mask } from "./types";
import { getContext2d, makeCanvas, type AnyImage, imageSize } from "./canvas";

/**
 * Rend transparents les pixels du masque, directement dans `image`.
 * Les composantes RVB sont aussi mises à zéro : retirer le canal alpha
 * ne doit pas permettre de retrouver la personne.
 */
export function applyMaskToImageData(image: ImageData, mask: Mask): ImageData {
  if (image.width !== mask.width || image.height !== mask.height) {
    throw new Error(
      `Taille du masque (${mask.width}×${mask.height}) ≠ image (${image.width}×${image.height})`,
    );
  }
  const px = image.data;
  const m = mask.data;
  for (let i = 0, j = 0; i < m.length; i++, j += 4) {
    if (m[i]) {
      px[j] = 0;
      px[j + 1] = 0;
      px[j + 2] = 0;
      px[j + 3] = 0;
    }
  }
  return image;
}

/** Copie l'image source et applique le masque. */
export function applyMask(image: AnyImage, mask: Mask): ImageData {
  const { width, height } = imageSize(image);
  const canvas = makeCanvas(width, height);
  const ctx = getContext2d(canvas);
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, width, height);
  return applyMaskToImageData(data, mask);
}
