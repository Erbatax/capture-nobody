/** Petits utilitaires canvas, compatibles OffscreenCanvas et DOM. */

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type AnyImage = ImageBitmap | HTMLCanvasElement | OffscreenCanvas | HTMLImageElement;
export type Ctx2d = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

export function getContext2d(canvas: AnyCanvas): Ctx2d {
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as Ctx2d | null;
  if (!ctx) throw new Error("Canvas 2D indisponible (image trop grande pour ce navigateur ?)");
  return ctx;
}

export function imageSize(image: AnyImage): { width: number; height: number } {
  if ("naturalWidth" in image) return { width: image.naturalWidth, height: image.naturalHeight };
  return { width: image.width, height: image.height };
}

export async function canvasToBlob(canvas: AnyCanvas, type: string): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Encodage impossible"))), type),
  );
}
