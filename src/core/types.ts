/** Carte de probabilités (0..1) d'appartenir à une personne, en basse résolution. */
export interface ProbMap {
  width: number;
  height: number;
  data: Float32Array;
}

/** Masque binaire : 1 = pixel à effacer, 0 = pixel conservé. */
export interface Mask {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Rectangle en pixels de l'image source. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Boîte « person » renvoyée par le détecteur, en pixels de l'image source. */
export interface Box extends Rect {
  score: number;
}

export interface Timings {
  /** Temps cumulé de segmentation (ms). */
  segmentationMs: number;
  /** Temps cumulé de détection (ms). */
  detectionMs: number;
  /** Temps total de detectPeople, préparation des tuiles incluse (ms). */
  totalMs: number;
  /** Nombre de passes (image entière + tuiles). */
  passes: number;
}

export interface Detections {
  /** Dimensions de l'image source analysée. */
  width: number;
  height: number;
  /**
   * Probabilité « personne » sur toute l'image (union max des passes),
   * à une résolution réduite. À agrandir vers width × height.
   */
  segmentationMask: ProbMap;
  boxes: Box[];
  timings: Timings;
}

export type MaskMode = "union" | "segmentation" | "detection";

export interface BuildMaskOptions {
  /** Seuil de probabilité pour la segmentation (défaut 0,5). */
  threshold?: number;
  /** Seuil de score pour les boîtes de la détection (défaut 0,5). */
  boxThreshold?: number;
  /** Rayon de dilatation en fraction du plus petit côté (défaut 0,015). */
  dilation?: number;
  /** Sources combinées (défaut "union"). */
  mode?: MaskMode;
}
