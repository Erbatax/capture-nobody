/**
 * Cœur réutilisable de l'effaceur de personnes. Aucune interface ici :
 * uniquement des fonctions à appeler depuis n'importe quelle app.
 *
 *   const models = await loadModels({ modelBasePath, wasmBasePath });
 *   const img = await loadImage(file);
 *   const det = await detectPeople(models, img.image);
 *   const mask = buildMask(det, { threshold: 0.25, dilation: 0.015 });
 *   const png = await encodePng(applyMask(img.image, mask));
 */
export { loadModels, MODEL_FILES } from "./models";
export type { Models, LoadModelsOptions, DetectorModel, Delegate } from "./models";
export { detectPeople } from "./detect";
export type { DetectOptions } from "./detect";
export { buildMask, dilate, dilationRadius, maskCoverage, DEFAULT_DILATION, DEFAULT_THRESHOLD } from "./mask";
export { applyMask, applyMaskToImageData } from "./apply";
export { encodePng } from "./encode";
export { loadImage, DEFAULT_MAX_PIXELS } from "./image";
export type { LoadedImage } from "./image";
export { listPngChunks, stripPngMetadata } from "./png";
export { planTiles } from "./tiling";
export type * from "./types";
