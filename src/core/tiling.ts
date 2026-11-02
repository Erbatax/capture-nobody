import type { ProbMap, Rect } from "./types";

export type Precision = "normal" | "high";

export interface TileOptions {
  /**
   * Nombre de tuiles sur le grand côté. 1 = image entière seulement.
   * "auto" choisit selon la taille de l'image.
   */
  grid?: number | "auto";
  /** Pour grid "auto" : "high" ajoute un rang de tuiles (plus lent, rattrape mieux les petites personnes). */
  precision?: Precision;
  /** Chevauchement entre tuiles voisines, en fraction de la tuile (défaut 0,2). */
  overlap?: number;
}

/** Choix automatique de la grille selon le grand côté de l'image. */
export function autoGrid(width: number, height: number, precision: Precision = "normal"): number {
  const long = Math.max(width, height);
  const base = long < 700 ? 1 : long < 1000 ? 2 : long < 2500 ? 3 : 4;
  return precision === "high" ? Math.max(2, base + 1) : base;
}

function axisTiles(length: number, count: number, overlap: number): Array<[number, number]> {
  if (count <= 1) return [[0, length]];
  // count tuiles de taille t, chevauchement t*overlap : length = t*(count - (count-1)*overlap)
  const size = Math.min(length, Math.ceil(length / (count - (count - 1) * overlap)));
  const step = (length - size) / (count - 1);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const start = Math.round(i * step);
    out.push([start, Math.min(size, length - start)]);
  }
  return out;
}

/**
 * Liste des régions à analyser : toujours l'image entière en premier,
 * puis une grille de tuiles qui se chevauchent (à peu près carrées).
 */
export function planTiles(width: number, height: number, options: TileOptions = {}): Rect[] {
  const overlap = options.overlap ?? 0.2;
  const grid = options.grid === undefined || options.grid === "auto" ? autoGrid(width, height, options.precision) : options.grid;
  const rects: Rect[] = [{ x: 0, y: 0, width, height }];
  if (grid <= 1) return rects;
  const landscape = width >= height;
  const nLong = grid;
  const nShort = Math.max(1, Math.round((grid * Math.min(width, height)) / Math.max(width, height)));
  const nx = landscape ? nLong : nShort;
  const ny = landscape ? nShort : nLong;
  if (nx === 1 && ny === 1) return rects;
  for (const [y, h] of axisTiles(height, ny, overlap)) {
    for (const [x, w] of axisTiles(width, nx, overlap)) {
      rects.push({ x, y, width: w, height: h });
    }
  }
  return rects;
}

/** Dimensions réduites pour que le grand côté vaille au plus `maxSide`. */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Projette `src` (qui couvre `region` de l'image source) dans `target`
 * (qui couvre toute l'image source, de taille sourceW × sourceH) en prenant le max.
 * Échantillonnage au plus proche : suffisant, le masque sera dilaté ensuite.
 */
export function compositeMax(
  target: ProbMap,
  src: ProbMap,
  region: Rect,
  sourceW: number,
  sourceH: number,
): void {
  const kx = target.width / sourceW;
  const ky = target.height / sourceH;
  const tx0 = Math.max(0, Math.floor(region.x * kx));
  const ty0 = Math.max(0, Math.floor(region.y * ky));
  const tx1 = Math.min(target.width, Math.ceil((region.x + region.width) * kx));
  const ty1 = Math.min(target.height, Math.ceil((region.y + region.height) * ky));
  const sxPerT = src.width / (region.width * kx);
  const syPerT = src.height / (region.height * ky);
  const t = target.data;
  const s = src.data;
  for (let ty = ty0; ty < ty1; ty++) {
    const sy = Math.min(src.height - 1, Math.max(0, Math.floor((ty + 0.5 - region.y * ky) * syPerT)));
    const srow = sy * src.width;
    const trow = ty * target.width;
    for (let tx = tx0; tx < tx1; tx++) {
      const sx = Math.min(src.width - 1, Math.max(0, Math.floor((tx + 0.5 - region.x * kx) * sxPerT)));
      const val = s[srow + sx];
      if (val > t[trow + tx]) t[trow + tx] = val;
    }
  }
}
