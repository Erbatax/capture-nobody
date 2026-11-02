import "./style.css";
import {
  applyMask,
  buildMask,
  detectPeople,
  encodePng,
  loadImage,
  maskCoverage,
  DEFAULT_DILATION,
  DEFAULT_THRESHOLD,
  DEFAULT_BOX_THRESHOLD,
  type Detections,
  type LoadedImage,
  type Mask,
  type MaskMode,
  type Models,
  type Precision,
} from "../core";
import { $, errorMessage, setupApp, fmtMb, fmtMs, getModels, renderOverlay, store } from "./shared";

type View = "result" | "overlay";
interface Settings {
  mode: MaskMode;
  /** Seuil de la détection (curseur principal). */
  boxThreshold: number;
  /** Seuil de la segmentation. */
  threshold: number;
  dilation: number;
  precision: Precision;
}
/** Durées de chaque étape, en ms, pour la dernière photo. */
interface StageTimes {
  read: number;
  segmentation: number;
  detection: number;
  mask: number;
  preview: number;
  png: number;
  /** Du choix de la photo au bouton d'export (temps réel ressenti). */
  total: number;
}
interface Current {
  loaded: LoadedImage;
  det: Detections;
  mask: Mask;
  result: ImageData;
  times: StageTimes;
  /** Instant où l'utilisateur a choisi la photo (ou relancé l'analyse). */
  startedAt: number;
}

const ZOOMS = [1, 2, 4, 8];
const SETTINGS_KEY = "nobody.settings.v2";

const el = {
  engine: $("engine"),
  engineLabel: $("engine-label"),
  engineDetail: $("engine-detail"),
  engineProgress: $("engine-progress") as HTMLProgressElement,
  error: $("error"),
  pick: $("pick") as HTMLInputElement,
  camera: $("camera") as HTMLInputElement,
  work: $("work"),
  workLabel: $("work-label"),
  workDetail: $("work-detail"),
  workProgress: $("work-progress") as HTMLProgressElement,
  preview: $("preview"),
  viewport: $("viewport"),
  canvas: $("canvas") as HTMLCanvasElement,
  info: $("info"),
  zoomIn: $("zoom-in") as HTMLButtonElement,
  zoomOut: $("zoom-out") as HTMLButtonElement,
  zoomValue: $("zoom-value"),
  mode: $("mode") as HTMLSelectElement,
  boxThreshold: $("box-threshold") as HTMLInputElement,
  boxThresholdValue: $("box-threshold-value"),
  threshold: $("threshold") as HTMLInputElement,
  thresholdValue: $("threshold-value"),
  precision: $("precision") as HTMLSelectElement,
  timing: $("timing"),
  dilation: $("dilation") as HTMLInputElement,
  dilationValue: $("dilation-value"),
  exportBox: $("export"),
  share: $("share") as HTMLButtonElement,
  download: $("download") as HTMLAnchorElement,
};

let models: Models | null = null;
let current: Current | null = null;
let view: View = "result";
let zoomIndex = 0;
let generation = 0;
let buildGeneration = 0;
let exportFile: File | null = null;
let exportUrl: string | null = null;
const settings: Settings = {
  mode: "union",
  boxThreshold: DEFAULT_BOX_THRESHOLD,
  threshold: DEFAULT_THRESHOLD,
  dilation: DEFAULT_DILATION,
  precision: "normal",
  ...store.get<Partial<Settings>>(SETTINGS_KEY, {}),
};

// ---------- Erreurs et export (échec sécuritaire) ----------

function clearExport(): void {
  el.exportBox.hidden = true;
  exportFile = null;
  if (exportUrl) URL.revokeObjectURL(exportUrl);
  exportUrl = null;
  el.download.removeAttribute("href");
}

function showError(message: string): void {
  clearExport();
  el.error.textContent = message;
  el.error.hidden = false;
}

function clearError(): void {
  el.error.hidden = true;
  el.error.textContent = "";
}

function setInputsEnabled(enabled: boolean): void {
  el.pick.disabled = !enabled;
  el.camera.disabled = !enabled;
}

// ---------- Modèles ----------

async function init(): Promise<void> {
  setInputsEnabled(false);
  try {
    models = await getModels("lite2", ({ loaded, total, step }) => {
      el.engineLabel.textContent = step;
      if (total) {
        el.engineProgress.max = total;
        el.engineProgress.value = loaded;
        el.engineDetail.textContent = `${fmtMb(loaded)} / ${fmtMb(total)}`;
      } else {
        el.engineProgress.removeAttribute("value");
        el.engineDetail.textContent = "";
      }
    });
    el.engineLabel.textContent = "Prêt — tout se passe sur cet appareil";
    el.engineDetail.textContent = `moteur ${models.delegate === "GPU" ? "GPU" : "CPU"}`;
    el.engineProgress.hidden = true;
    el.engine.classList.add("ok");
    setInputsEnabled(true);
  } catch (err) {
    models = null;
    el.engine.hidden = true;
    showError(
      `Les modèles n'ont pas pu être chargés. Aucun export n'est possible. (${errorMessage(err)}) ` +
        "Recharge la page avec une connexion pour la première visite.",
    );
  }
}

// ---------- Traitement ----------

async function handleFile(file: File | undefined): Promise<void> {
  if (!file) return;
  const gen = ++generation;
  clearError();
  clearExport();
  current = null;
  el.preview.hidden = true;
  if (!models) {
    showError("Les modèles ne sont pas chargés : traitement impossible.");
    return;
  }
  setInputsEnabled(false);
  el.work.hidden = false;
  el.workLabel.textContent = "Lecture de la photo…";
  el.workDetail.textContent = "";
  el.workProgress.removeAttribute("value");
  try {
    const startedAt = performance.now();
    const loaded = await loadImage(file);
    const read = performance.now() - startedAt;
    if (gen !== generation) return;
    await analyse(loaded, gen, startedAt, read);
  } catch (err) {
    current = null;
    el.preview.hidden = true;
    showError(`Échec du traitement : ${errorMessage(err)}. Aucun export n'est possible pour cette photo.`);
  } finally {
    if (gen === generation) {
      el.work.hidden = true;
      setInputsEnabled(!!models);
    }
  }
}

/** Lance les modèles sur une photo déjà chargée, puis construit le résultat. */
async function analyse(loaded: LoadedImage, gen: number, startedAt: number, read: number): Promise<void> {
  if (!models) throw new Error("Les modèles ne sont pas chargés.");
  el.workLabel.textContent = "Recherche des personnes…";
  const det = await detectPeople(models, loaded.image, {
    precision: settings.precision,
    onProgress: (done, total) => {
      el.workProgress.max = total;
      el.workProgress.value = done;
      el.workDetail.textContent = `passe ${done} / ${total}`;
    },
  });
  if (gen !== generation) return;
  current = {
    loaded,
    det,
    mask: null as unknown as Mask,
    result: null as unknown as ImageData,
    times: {
      read,
      segmentation: det.timings.segmentationMs,
      detection: det.timings.detectionMs,
      mask: 0,
      preview: 0,
      png: 0,
      total: 0,
    },
    startedAt,
  };
  await rebuild();
}

/** Relance les modèles sur la photo courante (après un changement de précision). */
async function reanalyse(): Promise<void> {
  if (!current || !models) return;
  const { loaded } = current;
  const gen = ++generation;
  clearError();
  clearExport();
  setInputsEnabled(false);
  el.precision.disabled = true;
  el.work.hidden = false;
  el.workProgress.removeAttribute("value");
  try {
    await analyse(loaded, gen, performance.now(), 0);
  } catch (err) {
    current = null;
    el.preview.hidden = true;
    showError(`Échec du traitement : ${errorMessage(err)}. Aucun export n'est possible pour cette photo.`);
  } finally {
    if (gen === generation) {
      el.work.hidden = true;
      el.precision.disabled = false;
      setInputsEnabled(!!models);
    }
  }
}

/** Recalcule masque + résultat avec les réglages courants, puis l'aperçu, puis l'export. */
async function rebuild(): Promise<void> {
  if (!current) return;
  const gen = ++buildGeneration;
  clearExport();
  const cur = current;
  const { loaded, det, times } = cur;
  // Un réglage modifié après coup : on mesure à partir de maintenant.
  if (times.total) {
    cur.startedAt = performance.now();
    times.read = times.segmentation = times.detection = 0;
  }
  let t = performance.now();
  const mask = buildMask(det, settings);
  const result = applyMask(loaded.image, mask);
  cur.mask = mask;
  cur.result = result;
  times.mask = performance.now() - t;
  t = performance.now();
  render();
  el.preview.hidden = false;
  updateInfo();
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); // laisse l'aperçu s'afficher
  times.preview = performance.now() - t;

  // L'export n'apparaît qu'une fois l'aperçu affiché.
  t = performance.now();
  const blob = await encodePng(result);
  if (gen !== buildGeneration || current !== cur) return;
  times.png = performance.now() - t;
  times.total = performance.now() - cur.startedAt;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  exportFile = new File([blob], `nobody-${stamp}.png`, { type: "image/png" });
  exportUrl = URL.createObjectURL(blob);
  el.download.href = exportUrl;
  el.download.download = exportFile.name;
  const canShare = typeof navigator.canShare === "function" && navigator.canShare({ files: [exportFile] });
  el.share.hidden = !canShare;
  el.download.classList.toggle("primary", !canShare);
  el.exportBox.hidden = false;
  el.info.textContent += ` · PNG ${fmtMb(blob.size)}`;
  updateTiming();
}

function updateTiming(): void {
  if (!current) return;
  const t = current.times;
  const steps: Array<[string, number]> = [
    ["lecture", t.read],
    ["segmentation", t.segmentation],
    ["détection", t.detection],
    ["masque", t.mask],
    ["aperçu", t.preview],
    ["PNG", t.png],
  ];
  el.timing.textContent =
    `Temps total ${fmtMs(t.total)} — ` +
    steps.filter(([, ms]) => ms > 0).map(([name, ms]) => `${name} ${fmtMs(ms)}`).join(" · ");
}

function render(): void {
  if (!current) return;
  const { result, mask, loaded } = current;
  const c = el.canvas;
  if (c.width !== result.width || c.height !== result.height) {
    c.width = result.width;
    c.height = result.height;
  }
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas indisponible");
  if (view === "result") ctx.putImageData(result, 0, 0);
  else renderOverlay(ctx, loaded.image, mask);
  el.viewport.classList.toggle("checker", view === "result");
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    b.setAttribute("aria-pressed", String(b.dataset.view === view));
  }
}

function updateInfo(): void {
  if (!current) return;
  const { loaded, det, mask } = current;
  const parts = [
    `${loaded.width}×${loaded.height}`,
    loaded.downscaled ? `réduite depuis ${loaded.originalWidth}×${loaded.originalHeight} (limite des navigateurs mobiles)` : "",
    loaded.mimeType || "type inconnu",
    `${(maskCoverage(mask) * 100).toFixed(1)} % effacé`,
    `${det.boxes.filter((b) => b.score >= settings.boxThreshold).length} boîtes`,
    `${det.timings.passes} passes`,
  ];
  el.timing.textContent = "";
  el.info.textContent = parts.filter(Boolean).join(" · ");
}

function applyZoom(): void {
  const z = ZOOMS[zoomIndex];
  el.canvas.style.width = `${z * 100}%`;
  el.zoomValue.textContent = `${z}×`;
  el.zoomOut.disabled = zoomIndex === 0;
  el.zoomIn.disabled = zoomIndex === ZOOMS.length - 1;
}

function syncSettingsUi(): void {
  el.mode.value = settings.mode;
  el.boxThreshold.value = String(settings.boxThreshold);
  el.threshold.value = String(settings.threshold);
  el.dilation.value = String(settings.dilation);
  el.precision.value = settings.precision;
  el.boxThresholdValue.textContent = settings.boxThreshold.toFixed(2);
  el.thresholdValue.textContent = settings.threshold.toFixed(2);
  el.dilationValue.textContent = `${(settings.dilation * 100).toFixed(2)} % du petit côté`;
}

let rebuildTimer: number | undefined;
function onSettingsChange(): void {
  settings.mode = el.mode.value as MaskMode;
  settings.boxThreshold = Number(el.boxThreshold.value);
  settings.threshold = Number(el.threshold.value);
  settings.dilation = Number(el.dilation.value);
  store.set(SETTINGS_KEY, settings);
  syncSettingsUi();
  clearExport();
  clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => {
    rebuild().catch((err) => showError(`Échec du traitement : ${errorMessage(err)}`));
  }, 200);
}

// ---------- Événements ----------

for (const input of [el.pick, el.camera]) {
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    void handleFile(file);
  });
}
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
  b.addEventListener("click", () => {
    view = b.dataset.view as View;
    render();
  });
}
el.zoomIn.addEventListener("click", () => {
  zoomIndex = Math.min(ZOOMS.length - 1, zoomIndex + 1);
  applyZoom();
});
el.zoomOut.addEventListener("click", () => {
  zoomIndex = Math.max(0, zoomIndex - 1);
  applyZoom();
});
el.mode.addEventListener("change", onSettingsChange);
el.threshold.addEventListener("input", onSettingsChange);
el.boxThreshold.addEventListener("input", onSettingsChange);
el.precision.addEventListener("change", () => {
  settings.precision = el.precision.value as Precision;
  store.set(SETTINGS_KEY, settings);
  void reanalyse();
});
el.dilation.addEventListener("input", onSettingsChange);
el.share.addEventListener("click", async () => {
  if (!exportFile) return;
  try {
    await navigator.share({ files: [exportFile] });
  } catch (err) {
    if ((err as DOMException)?.name !== "AbortError") el.download.click();
  }
});

syncSettingsUi();
applyZoom();
void init();
setupApp();
