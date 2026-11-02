import type { Box, BuildMaskOptions, Detections, Mask, ProbMap } from "./types";

export const DEFAULT_THRESHOLD = 0.25;
export const DEFAULT_DILATION = 0.015;

export function createMask(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(width * height) };
}

/**
 * Seuille une carte de probabilités en l'agrandissant (bilinéaire) vers
 * width × height, et OR le résultat dans `out`.
 */
export function rasterizeProbMap(prob: ProbMap, threshold: number, out: Mask): void {
  const { width: W, height: H, data: o } = out;
  const { width: pw, height: ph, data: p } = prob;
  if (pw === 0 || ph === 0) return;
  const sx = pw / W;
  const sy = ph / H;
  // Précalcul des indices et poids horizontaux.
  const x0s = new Int32Array(W);
  const x1s = new Int32Array(W);
  const wxs = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let fx = (x + 0.5) * sx - 0.5;
    if (fx < 0) fx = 0;
    if (fx > pw - 1) fx = pw - 1;
    const x0 = Math.floor(fx);
    x0s[x] = x0;
    x1s[x] = Math.min(x0 + 1, pw - 1);
    wxs[x] = fx - x0;
  }
  for (let y = 0; y < H; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    if (fy > ph - 1) fy = ph - 1;
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, ph - 1);
    const wy = fy - y0;
    const r0 = y0 * pw;
    const r1 = y1 * pw;
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const a = x0s[x];
      const b = x1s[x];
      const wx = wxs[x];
      const top = p[r0 + a] + (p[r0 + b] - p[r0 + a]) * wx;
      const bot = p[r1 + a] + (p[r1 + b] - p[r1 + a]) * wx;
      if (top + (bot - top) * wy >= threshold) o[row + x] = 1;
    }
  }
}

/** Remplit dans `out` chaque boîte dont le score atteint le seuil (coordonnées arrondies vers l'extérieur). */
export function rasterizeBoxes(boxes: Box[], threshold: number, out: Mask): void {
  const { width: W, height: H, data } = out;
  for (const b of boxes) {
    if (!(b.score >= threshold)) continue;
    const x0 = Math.max(0, Math.floor(b.x));
    const y0 = Math.max(0, Math.floor(b.y));
    const x1 = Math.min(W, Math.ceil(b.x + b.width));
    const y1 = Math.min(H, Math.ceil(b.y + b.height));
    for (let y = y0; y < y1; y++) data.fill(1, y * W + x0, y * W + x1);
  }
}

const INF = 1e20;

/** Transformée de distance 1D au carré (Felzenszwalb & Huttenlocher). */
function edt1d(
  f: Float32Array,
  n: number,
  d: Float32Array,
  v: Int32Array,
  z: Float32Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Dilatation par un disque de rayon `radius` (distance euclidienne exacte),
 * en O(largeur × hauteur) quel que soit le rayon. Renvoie un nouveau masque.
 */
export function dilate(mask: Mask, radius: number): Mask {
  const { width: W, height: H, data: src } = mask;
  const out = createMask(W, H);
  if (radius <= 0) {
    out.data.set(src);
    return out;
  }
  const r2 = radius * radius;
  // Passe 1 : distance verticale au pixel actif le plus proche, au carré (bornée).
  const cap = Math.ceil(radius) + 1;
  const capSq = cap * cap;
  const g = new Float32Array(W * H);
  for (let x = 0; x < W; x++) {
    let dist = cap;
    for (let y = 0; y < H; y++) {
      const i = y * W + x;
      dist = src[i] ? 0 : Math.min(dist + 1, cap);
      g[i] = dist;
    }
    dist = cap;
    for (let y = H - 1; y >= 0; y--) {
      const i = y * W + x;
      dist = src[i] ? 0 : Math.min(dist + 1, cap);
      const best = Math.min(dist, g[i]);
      g[i] = best >= cap ? INF : best * best;
    }
  }
  // Passe 2 : enveloppe inférieure de paraboles, ligne par ligne.
  const f = new Float32Array(W);
  const d = new Float32Array(W);
  const v = new Int32Array(W);
  const z = new Float32Array(W + 1);
  const o = out.data;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let any = false;
    for (let x = 0; x < W; x++) {
      const val = g[row + x];
      f[x] = val;
      if (val < capSq) any = true;
    }
    if (!any) continue;
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) if (d[x] <= r2) o[row + x] = 1;
  }
  return out;
}

/** Rayon de dilatation en pixels pour une image donnée. */
export function dilationRadius(width: number, height: number, dilation: number): number {
  return Math.max(0, Math.round(Math.min(width, height) * dilation));
}

/**
 * Construit le masque final à la taille de l'image source.
 * Règle prudente : union (selon le mode) de la segmentation et des boîtes,
 * puis dilatation. Fonction pure.
 */
export function buildMask(detections: Detections, options: BuildMaskOptions = {}): Mask {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const boxThreshold = options.boxThreshold ?? threshold;
  const dilation = options.dilation ?? DEFAULT_DILATION;
  const mode = options.mode ?? "union";
  const { width, height } = detections;
  const raw = createMask(width, height);
  if (mode !== "detection") rasterizeProbMap(detections.segmentationMask, threshold, raw);
  if (mode !== "segmentation") rasterizeBoxes(detections.boxes, boxThreshold, raw);
  return dilate(raw, dilationRadius(width, height, dilation));
}

/** Proportion de pixels effacés (0..1). */
export function maskCoverage(mask: Mask): number {
  let n = 0;
  const d = mask.data;
  for (let i = 0; i < d.length; i++) n += d[i];
  return d.length ? n / d.length : 0;
}
