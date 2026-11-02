import "./style.css";
import {
  buildMask,
  detectPeople,
  loadImage,
  DEFAULT_DILATION,
  DEFAULT_THRESHOLD,
  type Box,
  type Detections,
  type DetectorModel,
  type MaskMode,
} from "../core";
import { fitWithin } from "../core/tiling";
import { $, errorMessage, fmtMb, fmtMs, getModels, renderOverlay, store } from "./shared";

const MODES: MaskMode[] = ["union", "segmentation", "detection"];
const MODE_LABEL: Record<MaskMode, string> = {
  union: "Union",
  segmentation: "Segmentation seule",
  detection: "Détection seule",
};
const STORE_KEY = "nobody.eval.v1";
const SETTINGS_KEY = "nobody.eval.settings.v1";
const THUMB_SIDE = 1600;
const MAP_SIDE = 800;

interface Count {
  missed: number;
  falseErase: number;
  counted: boolean;
}
interface PhotoRecord {
  name: string;
  width: number;
  height: number;
  detector: DetectorModel;
  tiles: string;
  passes: number;
  timeMs: number;
  boxes: number;
  counts: Partial<Record<MaskMode, Count>>;
}
interface EvalStore {
  photos: Record<string, PhotoRecord>;
}
interface Settings {
  mode: MaskMode;
  threshold: number;
  dilation: number;
  tiles: string;
  detector: DetectorModel;
}
/** Données gardées en mémoire pour re-dessiner une carte sans relancer les modèles. */
interface Item {
  id: string;
  thumb: Blob;
  thumbW: number;
  thumbH: number;
  prob: { width: number; height: number; data: Uint8Array };
  boxes: Box[];
  img: HTMLImageElement;
  card: HTMLElement;
  overlayUrl?: string;
}

const el = {
  engine: $("engine"),
  engineLabel: $("engine-label"),
  engineDetail: $("engine-detail"),
  engineProgress: $("engine-progress") as HTMLProgressElement,
  error: $("error"),
  files: $("files") as HTMLInputElement,
  mode: $("mode") as HTMLSelectElement,
  threshold: $("threshold") as HTMLInputElement,
  thresholdValue: $("threshold-value"),
  dilation: $("dilation") as HTMLInputElement,
  dilationValue: $("dilation-value"),
  tiles: $("tiles") as HTMLSelectElement,
  detector: $("detector") as HTMLSelectElement,
  work: $("work"),
  workLabel: $("work-label"),
  workDetail: $("work-detail"),
  workProgress: $("work-progress") as HTMLProgressElement,
  tPhotos: $("t-photos"),
  tMissed: $("t-missed"),
  tFalse: $("t-false"),
  tTime: $("t-time"),
  compare: $("compare"),
  csv: $("csv") as HTMLButtonElement,
  reset: $("reset") as HTMLButtonElement,
  grid: $("grid"),
};

const data: EvalStore = store.get<EvalStore>(STORE_KEY, { photos: {} });
const settings: Settings = {
  mode: "union",
  threshold: DEFAULT_THRESHOLD,
  dilation: DEFAULT_DILATION,
  tiles: "auto",
  detector: "lite2",
  ...store.get<Partial<Settings>>(SETTINGS_KEY, {}),
};
const items: Item[] = [];
let busy = false;

const save = () => store.set(STORE_KEY, data);

function showError(msg: string): void {
  el.error.textContent = msg;
  el.error.hidden = false;
}

// ---------- Modèles ----------

async function ensureModels(detector: DetectorModel) {
  el.engine.hidden = false;
  el.engine.classList.remove("ok");
  el.engineProgress.hidden = false;
  const models = await getModels(detector, ({ loaded, total, step }) => {
    el.engineLabel.textContent = step;
    if (total) {
      el.engineProgress.max = total;
      el.engineProgress.value = loaded;
      el.engineDetail.textContent = `${fmtMb(loaded)} / ${fmtMb(total)}`;
    }
  });
  el.engineLabel.textContent = `Prêt — détecteur ${detector === "lite2" ? "EfficientDet-Lite2" : "EfficientDet-Lite0"}`;
  el.engineDetail.textContent = `moteur ${models.delegate}`;
  el.engineProgress.hidden = true;
  el.engine.classList.add("ok");
  return models;
}

// ---------- Traitement d'un lot ----------

function photoId(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

async function toJpeg(canvas: HTMLCanvasElement | OffscreenCanvas, quality = 0.85): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("JPEG"))), "image/jpeg", quality));
}

async function processFiles(files: File[]): Promise<void> {
  if (busy || !files.length) return;
  busy = true;
  el.files.disabled = true;
  el.error.hidden = true;
  el.work.hidden = false;
  el.workProgress.max = files.length;
  try {
    const models = await ensureModels(settings.detector);
    const grid = settings.tiles === "auto" ? "auto" : Number(settings.tiles);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      el.workLabel.textContent = `Photo ${i + 1} / ${files.length} — ${file.name}`;
      el.workProgress.value = i;
      const id = photoId(file);
      try {
        const loaded = await loadImage(file);
        const det = await detectPeople(models, loaded.image, {
          grid,
          segmentationMapSize: MAP_SIDE,
          onProgress: (d, t) => (el.workDetail.textContent = `passe ${d} / ${t}`),
        });
        const t = fitWithin(loaded.width, loaded.height, THUMB_SIDE);
        const canvas = new OffscreenCanvas(t.width, t.height);
        canvas.getContext("2d")!.drawImage(loaded.image, 0, 0, t.width, t.height);
        if ("close" in loaded.image) loaded.image.close();
        const thumb = await toJpeg(canvas, 0.9);
        const k = t.width / loaded.width;
        const prev = data.photos[id];
        data.photos[id] = {
          name: file.name,
          width: loaded.width,
          height: loaded.height,
          detector: settings.detector,
          tiles: settings.tiles,
          passes: det.timings.passes,
          timeMs: Math.round(det.timings.totalMs),
          boxes: det.boxes.length,
          counts: prev?.counts ?? {},
        };
        save();
        const sm = det.segmentationMask;
        const u8 = new Uint8Array(sm.data.length);
        for (let j = 0; j < u8.length; j++) u8[j] = Math.round(sm.data[j] * 255);
        const existing = items.findIndex((it) => it.id === id);
        if (existing >= 0) {
          items[existing].card.remove();
          items.splice(existing, 1);
        }
        const item = makeItem(id, thumb, t.width, t.height, { width: sm.width, height: sm.height, data: u8 },
          det.boxes.map((b) => ({ x: b.x * k, y: b.y * k, width: b.width * k, height: b.height * k, score: b.score })));
        items.push(item);
        await renderItem(item);
      } catch (err) {
        const card = document.createElement("article");
        card.className = "card failed";
        card.innerHTML = `<div class="body"><div class="name"></div><div class="muted small"></div></div>`;
        card.querySelector(".name")!.textContent = file.name;
        card.querySelector(".muted")!.textContent = `Échec : ${errorMessage(err)}`;
        el.grid.append(card);
      }
      updateTotals();
    }
    el.workProgress.value = files.length;
    el.workLabel.textContent = `${files.length} photo(s) traitée(s)`;
    el.workDetail.textContent = "";
  } catch (err) {
    showError(`Les modèles n'ont pas pu être chargés : ${errorMessage(err)}`);
  } finally {
    busy = false;
    el.files.disabled = false;
  }
}

// ---------- Cartes ----------

function makeItem(
  id: string,
  thumb: Blob,
  thumbW: number,
  thumbH: number,
  prob: Item["prob"],
  boxes: Box[],
): Item {
  const card = document.createElement("article");
  card.className = "card";
  const img = document.createElement("img");
  img.alt = "Original avec les zones effacées en rouge";
  img.style.width = "100%";
  img.style.display = "block";
  img.style.cursor = "zoom-in";
  img.addEventListener("click", () => openLightbox(img.src));
  const body = document.createElement("div");
  body.className = "body";
  card.append(img, body);
  el.grid.append(card);
  return { id, thumb, thumbW, thumbH, prob, boxes, img, card };
}

function counterRow(label: string, value: number, onChange: (delta: number) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "counter";
  const span = document.createElement("span");
  span.textContent = label;
  const ctl = document.createElement("span");
  ctl.className = "ctl";
  const minus = document.createElement("button");
  minus.type = "button";
  minus.textContent = "−";
  minus.setAttribute("aria-label", `${label} : moins`);
  const out = document.createElement("output");
  out.textContent = String(value);
  const plus = document.createElement("button");
  plus.type = "button";
  plus.textContent = "+";
  plus.setAttribute("aria-label", `${label} : plus`);
  minus.addEventListener("click", () => onChange(-1));
  plus.addEventListener("click", () => onChange(1));
  ctl.append(minus, out, plus);
  row.append(span, ctl);
  return row;
}

function getCount(rec: PhotoRecord, mode: MaskMode): Count {
  return rec.counts[mode] ?? { missed: 0, falseErase: 0, counted: false };
}

function renderBody(item: Item): void {
  const rec = data.photos[item.id];
  const body = item.card.querySelector(".body")!;
  body.replaceChildren();
  if (!rec) return;
  const c = getCount(rec, settings.mode);
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = rec.name;
  const meta = document.createElement("div");
  meta.className = "muted small";
  meta.textContent = `${rec.width}×${rec.height} · ${fmtMs(rec.timeMs)} · ${rec.passes} passes · ${rec.boxes} boîtes · ${rec.detector}`;
  const update = (patch: Partial<Count>) => {
    rec.counts[settings.mode] = { ...getCount(rec, settings.mode), ...patch, counted: true };
    save();
    renderBody(item);
    updateTotals();
  };
  const missed = counterRow("Personnes ratées", c.missed, (d) => update({ missed: Math.max(0, c.missed + d) }));
  const fake = counterRow("Faux effacements gênants", c.falseErase, (d) =>
    update({ falseErase: Math.max(0, c.falseErase + d) }),
  );
  const check = document.createElement("button");
  check.type = "button";
  check.className = "button";
  check.style.minHeight = "36px";
  check.textContent = c.counted ? `✓ Comptée (${MODE_LABEL[settings.mode]})` : "✓ Valider (rien à signaler)";
  check.setAttribute("aria-pressed", String(c.counted));
  check.addEventListener("click", () => update({}));
  body.append(name, meta, missed, fake, check);
}

async function renderItem(item: Item): Promise<void> {
  const prob = new Float32Array(item.prob.data.length);
  for (let i = 0; i < prob.length; i++) prob[i] = item.prob.data[i] / 255;
  const det: Detections = {
    width: item.thumbW,
    height: item.thumbH,
    segmentationMask: { width: item.prob.width, height: item.prob.height, data: prob },
    boxes: item.boxes,
    timings: { segmentationMs: 0, detectionMs: 0, totalMs: 0, passes: 0 },
  };
  const mask = buildMask(det, settings);
  const bmp = await createImageBitmap(item.thumb);
  const canvas = document.createElement("canvas");
  canvas.width = item.thumbW;
  canvas.height = item.thumbH;
  renderOverlay(canvas.getContext("2d", { willReadFrequently: true })!, bmp, mask);
  bmp.close();
  const jpeg = await toJpeg(canvas);
  if (item.overlayUrl) URL.revokeObjectURL(item.overlayUrl);
  item.overlayUrl = URL.createObjectURL(jpeg);
  item.img.src = item.overlayUrl;
  renderBody(item);
}

let rerenderTimer: number | undefined;
function rerenderAll(): void {
  clearTimeout(rerenderTimer);
  rerenderTimer = window.setTimeout(async () => {
    for (const it of items) await renderItem(it);
  }, 150);
}

function openLightbox(src: string): void {
  const box = document.createElement("div");
  box.className = "lightbox";
  const img = document.createElement("img");
  img.src = src;
  img.style.width = "200%";
  img.style.maxWidth = "none";
  box.append(img);
  box.addEventListener("click", () => box.remove());
  document.body.append(box);
}

// ---------- Totaux, comparaison, CSV ----------

function updateTotals(): void {
  const recs = Object.values(data.photos);
  const summary = MODES.map((mode) => {
    let photos = 0, missed = 0, falseErase = 0;
    for (const r of recs) {
      const c = r.counts[mode];
      if (c?.counted) {
        photos++;
        missed += c.missed;
        falseErase += c.falseErase;
      }
    }
    return { mode, photos, missed, falseErase };
  });
  const cur = summary.find((s) => s.mode === settings.mode)!;
  el.tPhotos.textContent = `${cur.photos} / ${recs.length}`;
  el.tMissed.textContent = String(cur.missed);
  el.tFalse.textContent = String(cur.falseErase);
  el.tTime.textContent = recs.length ? fmtMs(recs.reduce((n, r) => n + r.timeMs, 0) / recs.length) : "–";
  el.compare.replaceChildren(
    ...summary.map((s) => {
      const tr = document.createElement("tr");
      for (const v of [MODE_LABEL[s.mode], s.photos, s.missed, s.falseErase]) {
        const td = document.createElement("td");
        td.textContent = String(v);
        tr.append(td);
      }
      if (s.mode === settings.mode) tr.style.fontWeight = "700";
      return tr;
    }),
  );
}

function csvCell(v: unknown): string {
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(): void {
  const header = [
    "photo", "largeur", "hauteur", "detecteur", "tuiles", "passes", "temps_ms", "boites_brutes",
    "mode", "comptee", "personnes_ratees", "faux_effacements", "seuil", "marge",
  ];
  const rows = [header.join(",")];
  for (const r of Object.values(data.photos)) {
    for (const mode of MODES) {
      const c = getCount(r, mode);
      rows.push(
        [r.name, r.width, r.height, r.detector, r.tiles, r.passes, r.timeMs, r.boxes, mode,
          c.counted ? 1 : 0, c.missed, c.falseErase, settings.threshold, settings.dilation]
          .map(csvCell)
          .join(","),
      );
    }
  }
  const blob = new Blob(["﻿" + rows.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `nobody-eval-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Réglages ----------

function syncSettingsUi(): void {
  el.mode.value = settings.mode;
  el.threshold.value = String(settings.threshold);
  el.dilation.value = String(settings.dilation);
  el.tiles.value = settings.tiles;
  el.detector.value = settings.detector;
  el.thresholdValue.textContent = settings.threshold.toFixed(2);
  el.dilationValue.textContent = `${(settings.dilation * 100).toFixed(2)} %`;
}

function readSettings(): void {
  settings.mode = el.mode.value as MaskMode;
  settings.threshold = Number(el.threshold.value);
  settings.dilation = Number(el.dilation.value);
  settings.tiles = el.tiles.value;
  settings.detector = el.detector.value as DetectorModel;
  store.set(SETTINGS_KEY, settings);
  syncSettingsUi();
}

el.files.addEventListener("change", () => {
  const files = Array.from(el.files.files ?? []);
  el.files.value = "";
  void processFiles(files);
});
for (const input of [el.mode, el.threshold, el.dilation]) {
  input.addEventListener("input", () => {
    readSettings();
    updateTotals();
    rerenderAll();
  });
}
for (const input of [el.tiles, el.detector]) {
  input.addEventListener("change", () => {
    readSettings();
    showError("Tuiles et détecteur s'appliquent aux prochaines photos traitées : resélectionne le lot pour comparer.");
    if (input === el.detector) ensureModels(settings.detector).catch((e) => showError(errorMessage(e)));
  });
}
el.csv.addEventListener("click", exportCsv);
el.reset.addEventListener("click", () => {
  if (!confirm("Effacer tous les compteurs mémorisés ?")) return;
  for (const r of Object.values(data.photos)) r.counts = {};
  save();
  for (const it of items) renderBody(it);
  updateTotals();
});

syncSettingsUi();
updateTotals();
ensureModels(settings.detector)
  .then(() => (el.files.disabled = false))
  .catch((err) => showError(`Les modèles n'ont pas pu être chargés : ${errorMessage(err)}`));
