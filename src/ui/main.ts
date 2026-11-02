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
  type Detections,
  type LoadedImage,
  type Mask,
  type MaskMode,
  type Models,
} from "../core";
import { $, errorMessage, fmtMb, fmtMs, getModels, renderOverlay, store } from "./shared";

type View = "result" | "overlay";
interface Settings {
  mode: MaskMode;
  threshold: number;
  dilation: number;
}
interface Current {
  loaded: LoadedImage;
  det: Detections;
  mask: Mask;
  result: ImageData;
}

const ZOOMS = [1, 2, 4, 8];
const SETTINGS_KEY = "nobody.settings.v1";

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
  threshold: $("threshold") as HTMLInputElement,
  thresholdValue: $("threshold-value"),
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
  threshold: DEFAULT_THRESHOLD,
  dilation: DEFAULT_DILATION,
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
    const loaded = await loadImage(file);
    if (gen !== generation) return;
    el.workLabel.textContent = "Recherche des personnes…";
    const det = await detectPeople(models, loaded.image, {
      onProgress: (done, total) => {
        el.workProgress.max = total;
        el.workProgress.value = done;
        el.workDetail.textContent = `passe ${done} / ${total}`;
      },
    });
    if (gen !== generation) return;
    current = { loaded, det, mask: null as unknown as Mask, result: null as unknown as ImageData };
    await rebuild();
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

/** Recalcule masque + résultat avec les réglages courants, puis l'aperçu, puis l'export. */
async function rebuild(): Promise<void> {
  if (!current) return;
  const gen = ++buildGeneration;
  clearExport();
  const { loaded, det } = current;
  const mask = buildMask(det, settings);
  const result = applyMask(loaded.image, mask);
  current.mask = mask;
  current.result = result;
  render();
  el.preview.hidden = false;
  updateInfo();

  // L'export n'apparaît qu'une fois l'aperçu affiché.
  const blob = await encodePng(result);
  if (gen !== buildGeneration || !current) return;
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
    `${det.boxes.filter((b) => b.score >= settings.threshold).length} boîtes`,
    `${det.timings.passes} passes`,
    fmtMs(det.timings.totalMs),
  ];
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
  el.threshold.value = String(settings.threshold);
  el.dilation.value = String(settings.dilation);
  el.thresholdValue.textContent = settings.threshold.toFixed(2);
  el.dilationValue.textContent = `${(settings.dilation * 100).toFixed(2)} % du petit côté`;
}

let rebuildTimer: number | undefined;
function onSettingsChange(): void {
  settings.mode = el.mode.value as MaskMode;
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
