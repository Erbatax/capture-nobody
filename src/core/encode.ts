import { canvasToBlob, getContext2d, makeCanvas } from "./canvas";
import { stripPngMetadata } from "./png";

/**
 * Encode en PNG avec canal alpha. Le ré-encodage via canvas ne transporte
 * aucune métadonnée de la photo d'origine ; on retire en plus tout chunk
 * auxiliaire que le navigateur pourrait ajouter (profil ICC, pHYs, texte...).
 */
export async function encodePng(image: ImageData): Promise<Blob> {
  const canvas = makeCanvas(image.width, image.height);
  getContext2d(canvas).putImageData(image, 0, 0);
  const raw = await canvasToBlob(canvas, "image/png");
  const bytes = new Uint8Array(await raw.arrayBuffer());
  const clean = stripPngMetadata(bytes);
  return new Blob([clean as BlobPart], { type: "image/png" });
}
