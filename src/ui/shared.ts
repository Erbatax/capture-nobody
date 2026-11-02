import { registerSW } from "virtual:pwa-register";
import { loadModels, type DetectorModel, type Mask, type Models } from "../core";

declare const __APP_VERSION__: string;

/**
 * Service worker : précache pour le hors-ligne + bandeau quand une nouvelle
 * version est prête. On ne recharge jamais tout seul (traitement en cours).
 */
export function setupApp(): void {
  const version = document.getElementById("version");
  if (version) version.textContent = `version ${__APP_VERSION__}`;
  if (!("serviceWorker" in navigator)) return;
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      if (document.getElementById("update-banner")) return;
      const banner = document.createElement("div");
      banner.id = "update-banner";
      banner.className = "update-banner";
      banner.setAttribute("role", "status");
      const text = document.createElement("span");
      text.textContent = "Nouvelle version disponible.";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "button primary";
      btn.textContent = "Mettre à jour";
      btn.addEventListener("click", () => {
        btn.disabled = true;
        void updateSW(true);
      });
      banner.append(text, btn);
      document.body.append(banner);
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      // Vérifie les mises à jour au retour sur l'app et toutes les 30 min.
      const check = () => {
        if (navigator.onLine) reg.update().catch(() => {});
      };
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
      setInterval(check, 30 * 60 * 1000);
    },
  });
}

const BASE = import.meta.env.BASE_URL;

/** Modèles chargés une seule fois par type de détecteur. */
const cache = new Map<DetectorModel, Promise<Models>>();

export function getModels(
  detector: DetectorModel,
  onProgress: (p: { loaded: number; total: number; step: string }) => void,
): Promise<Models> {
  let p = cache.get(detector);
  if (!p) {
    p = loadModels({
      modelBasePath: `${BASE}models/`,
      wasmBasePath: `${BASE}wasm/`,
      detector,
      onProgress,
    });
    p.catch(() => cache.delete(detector));
    cache.set(detector, p);
  }
  return p;
}

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} manquant`);
  return el;
}

export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
export const fmtMb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} Mo`;

/** Dessine l'original avec les zones effacées en rouge semi-transparent. */
export function renderOverlay(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  mask: Mask,
  alpha = 0.55,
): void {
  const { width, height } = mask;
  ctx.drawImage(image, 0, 0, width, height);
  const img = ctx.getImageData(0, 0, width, height);
  const px = img.data;
  const m = mask.data;
  const keep = 1 - alpha;
  const red = 255 * alpha;
  for (let i = 0, j = 0; i < m.length; i++, j += 4) {
    if (m[i]) {
      px[j] = px[j] * keep + red;
      px[j + 1] = px[j + 1] * keep;
      px[j + 2] = px[j + 2] * keep;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** localStorage protégé : peut être indisponible (navigation privée, iOS...). */
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* stockage indisponible : on continue sans mémoriser */
    }
  },
};
