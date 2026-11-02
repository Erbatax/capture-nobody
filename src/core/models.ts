import { FilesetResolver, ImageSegmenter, ObjectDetector } from "@mediapipe/tasks-vision";

export type DetectorModel = "lite2" | "lite0";
export type Delegate = "GPU" | "CPU";

export const MODEL_FILES = {
  segmenter: "deeplab_v3.tflite",
  lite2: "efficientdet_lite2.tflite",
  lite0: "efficientdet_lite0.tflite",
} as const;

export interface LoadModelsOptions {
  /** Dossier des fichiers .tflite (servis par l'app). Défaut "/models/". */
  modelBasePath?: string;
  /** Dossier des fichiers WASM de MediaPipe (servis par l'app). Défaut "/wasm/". */
  wasmBasePath?: string;
  detector?: DetectorModel;
  /** "auto" essaie le GPU puis se replie sur le CPU. */
  delegate?: Delegate | "auto";
  /** Seuil minimal demandé au détecteur (on filtre ensuite). Défaut 0,1. */
  detectorMinScore?: number;
  onProgress?: (p: { loaded: number; total: number; step: string }) => void;
}

export interface Models {
  segmenter: ImageSegmenter;
  detector: ObjectDetector;
  /** Index de la classe « person » dans les masques de confiance du segmenteur. */
  personIndex: number;
  delegate: Delegate;
  detectorModel: DetectorModel;
  close(): void;
}

function join(base: string, file: string): string {
  return base.endsWith("/") ? base + file : `${base}/${file}`;
}

/** Télécharge un fichier en rapportant la progression (octets reçus). */
async function fetchBytes(url: string, onChunk: (n: number, total: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Modèle introuvable : ${url} (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onChunk(buf.length, buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    onChunk(size, total);
  }
  const out = new Uint8Array(size);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

async function create(
  fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
  segBuf: Uint8Array,
  detBuf: Uint8Array,
  delegate: Delegate,
  minScore: number,
): Promise<{ segmenter: ImageSegmenter; detector: ObjectDetector }> {
  const segmenter = await ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: segBuf, delegate },
    runningMode: "IMAGE",
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
  try {
    const detector = await ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: detBuf, delegate },
      runningMode: "IMAGE",
      scoreThreshold: minScore,
      maxResults: 100,
      categoryAllowlist: ["person"],
    });
    return { segmenter, detector };
  } catch (err) {
    segmenter.close();
    throw err;
  }
}

/**
 * Charge les deux modèles depuis des chemins locaux. Aucun CDN :
 * tout doit être servi par l'app (et préchargé par le service worker).
 * Lève une erreur si quoi que ce soit échoue (l'appelant doit bloquer l'export).
 */
export async function loadModels(options: LoadModelsOptions = {}): Promise<Models> {
  const modelBase = options.modelBasePath ?? "/models/";
  const wasmBase = options.wasmBasePath ?? "/wasm/";
  const detectorModel = options.detector ?? "lite2";
  const minScore = options.detectorMinScore ?? 0.1;
  const onProgress = options.onProgress ?? (() => {});

  const files = [MODEL_FILES.segmenter, MODEL_FILES[detectorModel]];
  const loaded = [0, 0];
  const totals = [0, 0];
  const report = () =>
    onProgress({
      loaded: loaded[0] + loaded[1],
      total: totals[0] && totals[1] ? totals[0] + totals[1] : 0,
      step: "Téléchargement des modèles",
    });
  const [segBuf, detBuf] = await Promise.all(
    files.map((f, i) =>
      fetchBytes(join(modelBase, f), (n, t) => {
        loaded[i] = n;
        totals[i] = t;
        report();
      }),
    ),
  );

  onProgress({ loaded: 1, total: 1, step: "Initialisation du moteur" });
  const fileset = await FilesetResolver.forVisionTasks(wasmBase.replace(/\/$/, ""));

  const order: Delegate[] =
    options.delegate === "GPU" ? ["GPU"] : options.delegate === "CPU" ? ["CPU"] : ["GPU", "CPU"];
  let lastError: unknown;
  for (const delegate of order) {
    try {
      // MediaPipe peut conserver une référence au buffer : on donne des copies.
      const { segmenter, detector } = await create(fileset, segBuf.slice(), detBuf.slice(), delegate, minScore);
      const labels = segmenter.getLabels().map((l) => l.toLowerCase());
      const personIndex = labels.length ? labels.indexOf("person") : 15;
      if (personIndex < 0) {
        segmenter.close();
        detector.close();
        throw new Error("Le modèle de segmentation n'a pas de classe « person ».");
      }
      return {
        segmenter,
        detector,
        personIndex,
        delegate,
        detectorModel,
        close() {
          segmenter.close();
          detector.close();
        },
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Impossible d'initialiser les modèles : ${String((lastError as Error)?.message ?? lastError)}`);
}
