import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Content-Security-Policy : rend techniquement impossible l'envoi d'une image
 * vers un autre domaine. Injectée en <meta> au build (en dev, Vite a besoin de
 * styles inline). Les mêmes règles sont envoyées en en-tête HTTP par nginx
 * (voir deploy/nginx.conf), qui ajoute frame-ancestors.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self'",
  "img-src 'self' blob: data:",
  "style-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function cspMeta(): Plugin {
  return {
    name: "csp-meta",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler: () => [
        { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" },
      ],
    },
  };
}

/**
 * MediaPipe Tasks (1.2.0) contient un journal d'usage qui envoie toutes les
 * 60 s, et à la fermeture, des statistiques (type de tâche, latences) à
 * https://odml.pa.googleapis.com/v1/log. Aucune image n'y figure, mais la
 * promesse est « rien ne sort » : on rend sa méthode flush() inopérante.
 * La CSP (connect-src 'self') bloquerait de toute façon l'envoi.
 * Si une mise à jour change ce code, le build échoue au lieu de laisser passer.
 */
function stripMediapipeTelemetry(): Plugin {
  const NEEDLE = "flush(t,e){if(this.error)";
  return {
    name: "strip-mediapipe-telemetry",
    enforce: "pre",
    transform(code, id) {
      if (!/@mediapipe[\\/]tasks-vision[\\/]vision_bundle\.mjs/.test(id)) return null;
      if (!code.includes("odml.pa.googleapis.com")) return null;
      const n = code.split(NEEDLE).length - 1;
      if (n !== 1) {
        this.error(
          `Télémétrie MediaPipe : motif « ${NEEDLE} » trouvé ${n} fois (attendu 1). ` +
            "Vérifie le code de journalisation de cette version avant de mettre à jour.",
        );
      }
      const patched = code
        .replace(NEEDLE, "flush(t,e){this.i=[];t?.();return;if(this.error)")
        .replace("https://odml.pa.googleapis.com/v1/log", "data:,telemetrie-desactivee");
      return { code: patched, map: null };
    },
  };
}

/** Identifiant de version affiché en bas de page : commit (fourni par Coolify) + date du build. */
const BUILD_DATE = new Date().toISOString().slice(0, 16).replace("T", " ");
const COMMIT = (process.env.SOURCE_COMMIT ?? "").slice(0, 7);
const APP_VERSION = COMMIT ? `${COMMIT} · ${BUILD_DATE} UTC` : `${BUILD_DATE} UTC`;

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  // Pas de pré-bundle : la neutralisation de la télémétrie s'applique aussi en dev.
  optimizeDeps: { exclude: ["@mediapipe/tasks-vision"] },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        eval: fileURLToPath(new URL("eval.html", import.meta.url)),
      },
    },
  },
  plugins: [
    stripMediapipeTelemetry(),
    cspMeta(),
    VitePWA({
      // « prompt » : la nouvelle version attend que l'utilisateur la demande
      // (bandeau « Nouvelle version »), pour ne jamais recharger en plein traitement.
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        name: "Capture Nobody — effaceur de personnes",
        short_name: "Nobody",
        description: "Rend les personnes transparentes sur vos photos. Tout reste sur le téléphone.",
        lang: "fr",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#111214",
        theme_color: "#111214",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Précharge l'app, le moteur WASM et les modèles : tout fonctionne hors ligne.
        // Les .tflite et le .wasm dépassent la limite par défaut de 2 Mo.
        globPatterns: ["**/*.{js,css,html,png,svg,webmanifest,wasm,tflite}"],
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
        // Lite0 ne sert qu'à la comparaison sur /eval : mis en cache au premier usage.
        globIgnores: ["**/efficientdet_lite0.tflite"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith(".tflite"),
            handler: "CacheFirst",
            options: { cacheName: "models-extra" },
          },
        ],
        // /eval est servi par le précache (cleanURLs → eval.html).
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/eval/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
