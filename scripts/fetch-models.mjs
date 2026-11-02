#!/usr/bin/env node
/**
 * Prépare les fichiers servis localement par l'app :
 *  - public/models/ : modèles .tflite téléchargés une fois depuis Google (MediaPipe)
 *  - public/wasm/   : moteur WASM copié depuis node_modules/@mediapipe/tasks-vision
 *
 * Idempotent : un fichier déjà présent avec la bonne empreinte n'est pas retéléchargé.
 * Ces fichiers ne sont PAS dans le dépôt (voir .gitignore) : ils sont générés au build.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = join(root, "public", "models");
const wasmDir = join(root, "public", "wasm");
const wasmSrc = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");

const BASE = "https://storage.googleapis.com/mediapipe-models";
// Versions figées (pas « latest ») pour des résultats reproductibles.
// Empreintes SHA-256 vérifiées à chaque téléchargement.
const MODELS = [
  {
    file: "deeplab_v3.tflite",
    url: `${BASE}/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite`,
    sha256: "ff36e24d40547fe9e645e2f4e8745d1876d6e38b332d39a82f0bf0f5d1d561b3",
  },
  {
    file: "efficientdet_lite2.tflite",
    url: `${BASE}/object_detector/efficientdet_lite2/float16/1/efficientdet_lite2.tflite`,
    sha256: "5d4ebec1029bc9907aeadb9e7b4ac9cb1da6a19d01ad375210a9ae18ba173302",
  },
  {
    file: "efficientdet_lite0.tflite",
    url: `${BASE}/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite`,
    sha256: "4b59100025bea1235a84c1038879a6cccc9f6c49f5e41144e91e74d99e780993",
  },
];

// Seule la variante SIMD (classique, non-module) est utilisée : tous les navigateurs
// visés (Safari ≥ 16.4, Chrome ≥ 91) gèrent le SIMD WebAssembly.
const WASM_FILES = ["vision_wasm_internal.js", "vision_wasm_internal.wasm"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchModel({ file, url, sha256: expected }) {
  const dest = join(modelsDir, file);
  const pinned = /^[0-9a-f]{64}$/.test(expected);
  if (await exists(dest)) {
    const current = sha256(await readFile(dest));
    if (!pinned || current === expected) {
      console.log(`✓ ${file} (déjà présent)`);
      return;
    }
    console.log(`↻ ${file} : empreinte différente, nouveau téléchargement`);
  }
  console.log(`↓ ${file} ← ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Échec du téléchargement de ${url} : HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (pinned && got !== expected) {
    throw new Error(`Empreinte inattendue pour ${file} : ${got} (attendu ${expected})`);
  }
  await writeFile(dest + ".part", buf);
  await rename(dest + ".part", dest);
  console.log(`✓ ${file} (${(buf.length / 1e6).toFixed(1)} Mo, sha256 ${got})`);
}

await mkdir(modelsDir, { recursive: true });
await mkdir(wasmDir, { recursive: true });
for (const m of MODELS) await fetchModel(m);
for (const f of WASM_FILES) {
  await copyFile(join(wasmSrc, f), join(wasmDir, f));
  console.log(`✓ wasm/${f}`);
}
