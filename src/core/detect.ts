import type { Models } from "./models";
import { getContext2d, imageSize, makeCanvas, type AnyImage } from "./canvas";
import { compositeMax, fitWithin, planTiles, type TileOptions } from "./tiling";
import type { Box, Detections, ProbMap } from "./types";

export interface DetectOptions extends TileOptions {
  /** Grand côté de chaque passe envoyée aux modèles (défaut 640). */
  passSize?: number;
  /** Grand côté maximal de la carte de segmentation composée (défaut 2048). */
  segmentationMapSize?: number;
  /** Progression : passes terminées / total. */
  onProgress?: (done: number, total: number) => void;
}

const nextFrame = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Détecte les personnes : segmentation + détection d'objets, sur l'image
 * entière puis sur des tuiles qui se chevauchent. Toute erreur est propagée
 * (l'appelant ne doit alors rien exporter).
 */
export async function detectPeople(
  models: Models,
  image: AnyImage,
  options: DetectOptions = {},
): Promise<Detections> {
  const t0 = performance.now();
  const { width, height } = imageSize(image);
  const passSize = options.passSize ?? 640;
  const mapSize = fitWithin(width, height, options.segmentationMapSize ?? 2048);
  const segmentationMask: ProbMap = {
    width: mapSize.width,
    height: mapSize.height,
    data: new Float32Array(mapSize.width * mapSize.height),
  };
  const boxes: Box[] = [];
  const regions = planTiles(width, height, options);
  let segmentationMs = 0;
  let detectionMs = 0;

  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const size = fitWithin(r.width, r.height, passSize);
    const canvas = makeCanvas(size.width, size.height);
    const ctx = getContext2d(canvas);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, r.x, r.y, r.width, r.height, 0, 0, size.width, size.height);

    // Segmentation
    let t = performance.now();
    const seg = models.segmenter.segment(canvas);
    try {
      const masks = seg.confidenceMasks;
      const m = masks?.[models.personIndex];
      if (!m) throw new Error("La segmentation n'a renvoyé aucun masque.");
      const data = m.getAsFloat32Array();
      compositeMax(segmentationMask, { width: m.width, height: m.height, data }, r, width, height);
    } finally {
      seg.close();
    }
    segmentationMs += performance.now() - t;

    // Détection
    t = performance.now();
    const det = models.detector.detect(canvas);
    const sx = r.width / size.width;
    const sy = r.height / size.height;
    for (const d of det.detections) {
      const bb = d.boundingBox;
      const cat = d.categories?.[0];
      if (!bb || !cat || cat.categoryName.toLowerCase() !== "person") continue;
      boxes.push({
        x: r.x + bb.originX * sx,
        y: r.y + bb.originY * sy,
        width: bb.width * sx,
        height: bb.height * sy,
        score: cat.score,
      });
    }
    detectionMs += performance.now() - t;

    options.onProgress?.(i + 1, regions.length);
    await nextFrame();
  }

  return {
    width,
    height,
    segmentationMask,
    boxes,
    timings: {
      segmentationMs,
      detectionMs,
      totalMs: performance.now() - t0,
      passes: regions.length,
    },
  };
}
