# Capture Nobody — effaceur de personnes (preuve de concept)

PWA qui rend **transparentes** les personnes présentes sur une photo. Rien n'est inventé à leur place : les zones effacées deviennent des trous (alpha = 0, et RVB = 0 pour qu'on ne puisse rien récupérer en retirant le canal alpha).

**Aucune image ne quitte le téléphone, et tout fonctionne hors ligne** après la première visite.

La question à laquelle ce prototype doit répondre : *combien de personnes le modèle rate-t-il sur de vraies photos de lieux ?* C'est le rôle de la page [`/eval`](#page-dévaluation-eval).

## Démarrage

```bash
npm ci
npm run dev        # télécharge les modèles si besoin, puis lance Vite
npm test           # tests Vitest du cœur
npm run build      # prebuild = fetch-models, puis tsc + vite build → dist/
npm run preview    # sert dist/ (service worker actif) sur http://localhost:4173
```

Le service worker ne fonctionne qu'en HTTPS ou sur `localhost`.

## Fonctionnement

1. **Entrée** : « Choisir une photo » (galerie) ou « Prendre une photo » (`capture="environment"`).
2. **Chargement** : `createImageBitmap(file, { imageOrientation: "from-image" })`, avec repli sur `<img>`. Au-delà de 16 Mpx (limite des canvas sur iOS), la photo est réduite et l'app l'indique.
3. **Détection**, sur l'image entière puis sur une grille de tuiles qui se chevauchent de 20 %. Le nombre de tuiles sur le grand côté dépend de sa taille : 1 sous 700 px, 2 sous 1000 px, 3 sous 2500 px, 4 au-delà. La précision **élevée** ajoute un rang de tuiles : plus lent, mais les petites personnes au loin sont mieux rattrapées.
   - **segmentation** DeepLabV3 (classe `person`, masque de confiance) ;
   - **détection** EfficientDet-Lite2 (classe `person`, boîtes, seuil interne 0,1).
4. **Masque prudent** : union de la segmentation et des boîtes, chacune avec **son propre seuil** (0,5 par défaut pour les deux), puis dilatation par un disque de rayon ≈ 1,5 % du plus petit côté. Tout est réglable. Sur les photos de lieux testées, c'est la détection qui fait l'essentiel du travail : le curseur principal est donc son seuil.
5. **Aperçu obligatoire** : résultat sur damier, ou original avec les zones effacées en rouge, zoom jusqu'à 8×. Le bouton d'export n'apparaît qu'une fois l'aperçu affiché.
6. **Export** : PNG RGBA. Il ne contient que les chunks `IHDR`, `PLTE`, `tRNS`, `IDAT` et `IEND`, sans EXIF, GPS, profil ICC ni texte. Partage via `navigator.share({ files })` (sur iOS, « Enregistrer l'image » met la photo dans la galerie), avec un lien de téléchargement en repli.
7. **Échec sécuritaire** : si un modèle ne se charge pas, ou si l'inférence plante, aucun bouton d'export n'est affiché et un message rouge explique pourquoi.

## Modèles et licences

| Fichier | Rôle | Source | Licence |
|---|---|---|---|
| `deeplab_v3.tflite` (2,8 Mo, float32, entrée 257×257) | Segmentation, 21 classes PASCAL VOC dont `person` | [MediaPipe Image Segmenter](https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite) | Apache 2.0 (*) |
| `efficientdet_lite2.tflite` (12,1 Mo, float16, entrée 448×448) | Détection d'objets COCO, filtrée sur `person` | [MediaPipe Object Detector](https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/1/efficientdet_lite2.tflite) | Apache 2.0 (*) |
| `efficientdet_lite0.tflite` (7,3 Mo, float16) | Variante rapide, comparée sur `/eval` | [MediaPipe Object Detector](https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite) | Apache 2.0 (*) |
| `@mediapipe/tasks-vision` 1.2.0 (JS + WASM) | Moteur d'inférence | npm | Apache 2.0 (vérifié dans `package.json`) |

(*) Ce sont les modèles publiés par Google dans la collection MediaPipe. Les architectures d'origine sont publiées sous Apache 2.0 : DeepLab dans `tensorflow/models`, EfficientDet dans `google/automl`. Les fichiers `.tflite` ne contiennent pas de métadonnées de licence. **À confirmer avant la production** : je n'ai pas pu consulter les fiches de modèles de Google (ai.google.dev) depuis l'environnement de développement. Données d'entraînement : PASCAL VOC (DeepLab) et COCO (EfficientDet).

**Volontairement exclus** : Ultralytics YOLO et tout ce qui est sous (A)GPL, ainsi que le modèle « selfie » de MediaPipe, conçu pour des gens proches de la caméra.

Les versions des modèles sont **figées** (`/1/`, pas `latest`) et leurs empreintes SHA-256 sont vérifiées par `scripts/fetch-models.mjs`.

## Fichiers générés (non commités)

`npm run fetch-models` (lancé automatiquement par `dev` et `build`) :

- télécharge les trois `.tflite` dans `public/models/` et vérifie leur SHA-256 ;
- copie `vision_wasm_internal.{js,wasm}` depuis `node_modules/@mediapipe/tasks-vision/wasm/` vers `public/wasm/`.

Ces dossiers sont dans `.gitignore`. Le build a donc besoin d'Internet une fois. L'app, elle, n'en a jamais besoin pour traiter une photo.

Seule la variante WASM **SIMD** est servie : Safari ≥ 16.4 et Chrome ≥ 91 la gèrent. Sur un navigateur plus ancien, le chargement échoue proprement (échec sécuritaire).

## Garanties « rien ne sort »

- **Content-Security-Policy stricte** (`vite.config.ts` → `CSP`), injectée en `<meta>` au build et envoyée en en-tête par nginx. Un test vérifie que les deux sont identiques.
  ```
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self';
  img-src 'self' blob: data:; style-src 'self'; worker-src 'self'; …; frame-ancestors 'none'
  ```
- **Télémétrie MediaPipe neutralisée.** `@mediapipe/tasks-vision` 1.2.0 contient un journal d'usage qui envoie toutes les 60 s, et à la fermeture, des statistiques (type de tâche, mode, latences et une clé d'API Google, sans aucune image) à `https://odml.pa.googleapis.com/v1/log`. Il a été repéré grâce à la CSP, qui le bloquait. Le plugin Vite `strip-mediapipe-telemetry` rend sa méthode `flush()` inopérante. Si une mise à jour de MediaPipe change ce code, **le build échoue** au lieu de laisser passer. La version de la librairie est figée (`"1.2.0"`, sans `^`).
- Modèles et WASM servis par l'app elle-même : aucun CDN.
- Aucune analytique, aucun suivi.

## Hors ligne

`vite-plugin-pwa` (Workbox, `generateSW`) précharge environ 29 Mo : l'app, le WASM, DeepLabV3 et Lite2. `maximumFileSizeToCacheInBytes` est relevé à 30 Mo, car Workbox ignore par défaut les fichiers de plus de 2 Mo. Lite0 n'est mis en cache qu'au premier usage, sur `/eval`.

## Architecture

```
src/core/          librairie pure, sans interface, réutilisable telle quelle
  index.ts         API publique
  models.ts        loadModels({ modelBasePath, wasmBasePath, detector, delegate, onProgress })
  detect.ts        detectPeople(models, image, { grid, precision, overlap, onProgress }) → { segmentationMask, boxes, timings }
  mask.ts          buildMask(detections, { boxThreshold, threshold, dilation, mode }) → Mask   (pur)
  tiling.ts        planTiles, compositeMax                                                    (pur)
  apply.ts         applyMask(image, mask) → ImageData (alpha = 0 et RVB = 0)
  encode.ts        encodePng(imageData) → Blob sans métadonnées
  png.ts           listPngChunks, stripPngMetadata                                            (pur)
  image.ts         loadImage(file) : orientation EXIF + limite de 16 Mpx
src/ui/            main.ts (app), eval.ts (/eval), shared.ts, style.css
tests/             Vitest : buildMask, dilatation (comparée à une version naïve), tuiles, PNG, CSP
scripts/           fetch-models.mjs
deploy/nginx.conf  en-têtes de sécurité et cache
```

Différence avec la fiche : `detectPeople` reçoit les modèles en premier argument (`detectPeople(models, image)`) au lieu d'un état global. La librairie reste ainsi sans singleton.

La dilatation utilise une transformée de distance euclidienne exacte (Felzenszwalb & Huttenlocher), en O(n) quel que soit le rayon.

## Page d'évaluation (`/eval`)

- Sélection d'un lot de photos, traitées une à une.
- Pour chaque photo : l'original avec les zones en rouge (clic pour agrandir), les compteurs « personnes ratées » et « faux effacements gênants », le bouton ✓ « rien à signaler », et le temps de traitement.
- **Mode** (union, segmentation seule, détection seule), seuil et marge : la grille se redessine sans relancer les modèles. Les compteurs sont **séparés par mode**. Le tableau « Comparaison des modes » donne les totaux de chacun.
- Tuiles (auto normal ou élevé, grille de 1 à 5) et détecteur (Lite2 ou Lite0) s'appliquent au prochain lot.
- Temps par photo, détaillé en lecture, segmentation et détection (aussi dans le CSV).
- Compteurs mémorisés dans `localStorage` (avec try/catch), export CSV : une ligne par photo et par mode.

## Déploiement sur Coolify

1. Dans Coolify : **New Resource → Public Repository** (ou GitHub App) → `https://github.com/Erbatax/capture-nobody`.
2. **Build Pack : Dockerfile** (le `Dockerfile` est à la racine). Port exposé : **80**.
3. Ajoute un domaine en `https://…`. Coolify (Traefik) gère le certificat Let's Encrypt. Le HTTPS est obligatoire pour le service worker et l'installation.
4. Deploy. Le build lance `npm ci`, `npm test`, puis `npm run build` (télécharge les modèles et vérifie les SHA-256). nginx sert ensuite `dist/` avec la CSP et les en-têtes de `deploy/nginx.conf`.

Le Dockerfile n'a pas pu être testé dans l'environnement de développement (pas de démon Docker). La première exécution se fera donc sur Coolify.

## Vérifications

| Critère | Comment vérifier | État |
|---|---|---|
| Aucune requête réseau pendant le traitement | DevTools → Network pendant un traitement | ✅ vérifié automatiquement (Chromium/Playwright) : 0 requête |
| Hors ligne après une première visite | Mode avion → recharger → traiter → exporter | ✅ Chromium hors ligne : app et `/eval` OK. 📱 À faire sur iPhone et Android |
| PNG transparent sans métadonnées | `exiftool nobody-*.png` ; ou chunks = IHDR/IDAT/IEND | ✅ RGBA, chunks IHDR/IDAT/IEND, photo source avec GPS EXIF |
| Orientation | Photo avec EXIF orientation 6 | ✅ même sortie que la photo droite |
| Grandes photos | 12 Mpx traitée ; 24 Mpx réduite à 16 Mpx avec message | ✅ |
| Installation iPhone et Android | Safari → Partager → Sur l'écran d'accueil ; Chrome → Installer | 📱 À faire |
| HEIC sur iPhone | Le type reçu est affiché sous l'aperçu (`image/jpeg` attendu, iOS convertit) | 📱 À faire |
| `/eval` sur 30 photos + CSV | | ✅ testé sur 4 photos |

Sous l'aperçu, l'app affiche le **temps réel total** (du choix de la photo au bouton d'export), détaillé par étape : lecture, segmentation, détection, masque, aperçu, PNG.

Les temps mesurés dans l'environnement de test (GPU émulé, 3 à 25 s par photo) ne sont **pas représentatifs** d'un téléphone : ce sont ceux de `/eval` sur l'appareil qui comptent.

## Limites connues (v1)

- L'inférence tourne sur le fil principal : l'interface peut se figer quelques instants entre deux passes. Prochaine étape : un Web Worker.
- DeepLabV3 travaille en 257×257 : seules les tuiles le rendent utile sur les petites silhouettes. Les personnes de moins d'une quinzaine de pixels (kitesurfeurs au loin, par exemple) sont souvent ratées. C'est précisément ce que `/eval` doit chiffrer.
- Les boîtes sont effacées en entier (rectangles) : c'est la règle prudente.
