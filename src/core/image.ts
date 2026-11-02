import { getContext2d, imageSize, makeCanvas, type AnyCanvas } from "./canvas";

/** Limite de surface des canvas sur iOS Safari ≈ 16,7 Mpx ; on garde une marge. */
export const DEFAULT_MAX_PIXELS = 16_000_000;

export interface LoadedImage {
  /** Image prête à l'emploi, orientation EXIF déjà appliquée. */
  image: ImageBitmap | AnyCanvas;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  /** Vrai si l'image a été réduite pour tenir sous maxPixels. */
  downscaled: boolean;
  /** Type MIME reçu de l'input (utile pour vérifier le HEIC sur iOS). */
  mimeType: string;
}

/** Facteur d'échelle pour tenir sous maxPixels (1 si déjà assez petit). */
export function scaleForMaxPixels(width: number, height: number, maxPixels: number): number {
  const px = width * height;
  return px <= maxPixels ? 1 : Math.sqrt(maxPixels / px);
}

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (err) {
    // Repli : <img> applique l'orientation EXIF par défaut (CSS image-orientation: from-image).
    if (typeof document === "undefined") throw err;
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Charge une photo en respectant l'orientation EXIF, et la réduit si elle
 * dépasse maxPixels. Les métadonnées ne survivent pas au décodage.
 */
export async function loadImage(
  file: Blob,
  options: { maxPixels?: number } = {},
): Promise<LoadedImage> {
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  let decoded: ImageBitmap | HTMLImageElement;
  try {
    decoded = await decode(file);
  } catch {
    throw new Error(
      `Impossible de lire cette image (type « ${file.type || "inconnu"} »). Essaie une photo JPEG ou PNG.`,
    );
  }
  const { width: ow, height: oh } = imageSize(decoded);
  if (!ow || !oh) throw new Error("Image vide ou illisible.");
  const scale = scaleForMaxPixels(ow, oh, maxPixels);
  const base = { originalWidth: ow, originalHeight: oh, mimeType: file.type };
  if (scale === 1 && decoded instanceof ImageBitmap) {
    return { ...base, image: decoded, width: ow, height: oh, downscaled: false };
  }
  const width = Math.max(1, Math.floor(ow * scale));
  const height = Math.max(1, Math.floor(oh * scale));
  const canvas = makeCanvas(width, height);
  const ctx = getContext2d(canvas);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(decoded, 0, 0, width, height);
  if (decoded instanceof ImageBitmap) decoded.close();
  return { ...base, image: canvas, width, height, downscaled: scale < 1 };
}
