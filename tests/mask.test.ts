import { describe, expect, it } from "vitest";
import { buildMask, createMask, dilate, dilationRadius, maskCoverage, rasterizeProbMap } from "../src/core/mask";
import type { Detections, Mask, ProbMap } from "../src/core/types";

function count(m: Mask): number {
  return m.data.reduce((n, v) => n + v, 0);
}
function at(m: Mask, x: number, y: number): number {
  return m.data[y * m.width + x];
}
function emptyProb(w: number, h: number): ProbMap {
  return { width: w, height: h, data: new Float32Array(w * h) };
}
function detections(w: number, h: number, extra: Partial<Detections> = {}): Detections {
  return {
    width: w,
    height: h,
    segmentationMask: emptyProb(10, 10),
    boxes: [],
    timings: { segmentationMs: 0, detectionMs: 0, totalMs: 0, passes: 1 },
    ...extra,
  };
}

describe("dilate", () => {
  it("rayon 0 = copie identique", () => {
    const m = createMask(5, 5);
    m.data[12] = 1;
    const d = dilate(m, 0);
    expect(Array.from(d.data)).toEqual(Array.from(m.data));
    expect(d.data).not.toBe(m.data);
  });

  it("un point devient un disque euclidien exact", () => {
    const m = createMask(41, 41);
    m.data[20 * 41 + 20] = 1;
    const r = 7;
    const d = dilate(m, r);
    for (let y = 0; y < 41; y++)
      for (let x = 0; x < 41; x++) {
        const inside = (x - 20) ** 2 + (y - 20) ** 2 <= r * r;
        expect(at(d, x, y)).toBe(inside ? 1 : 0);
      }
  });

  it("masque vide reste vide", () => {
    expect(count(dilate(createMask(30, 20), 5))).toBe(0);
  });

  it("gère les bords sans déborder", () => {
    const m = createMask(10, 10);
    m.data[0] = 1;
    const d = dilate(m, 3);
    expect(at(d, 0, 0)).toBe(1);
    expect(at(d, 3, 0)).toBe(1);
    expect(at(d, 0, 3)).toBe(1);
    expect(at(d, 3, 3)).toBe(0); // 18 > 9
    expect(at(d, 2, 2)).toBe(1); // 8 <= 9
  });

  it("correspond à une dilatation naïve sur un masque aléatoire", () => {
    const W = 37, H = 23, r = 4;
    const m = createMask(W, H);
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < m.data.length; i++) m.data[i] = rnd() < 0.03 ? 1 : 0;
    const d = dilate(m, r);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let hit = 0;
        for (let yy = 0; yy < H && !hit; yy++)
          for (let xx = 0; xx < W; xx++)
            if (m.data[yy * W + xx] && (xx - x) ** 2 + (yy - y) ** 2 <= r * r) { hit = 1; break; }
        expect(at(d, x, y)).toBe(hit);
      }
  });
});

describe("dilationRadius", () => {
  it("≈1,5 % du plus petit côté", () => {
    expect(dilationRadius(4032, 3024, 0.015)).toBe(45);
    expect(dilationRadius(100, 200, 0)).toBe(0);
  });
});

describe("rasterizeProbMap", () => {
  it("agrandit et seuille une carte basse résolution", () => {
    const prob = emptyProb(4, 4);
    prob.data[1 * 4 + 1] = 1; // cellule (1,1) → pixels ~[10..20) sur 40
    const out = createMask(40, 40);
    rasterizeProbMap(prob, 0.5, out);
    expect(at(out, 15, 15)).toBe(1);
    expect(at(out, 35, 35)).toBe(0);
    expect(at(out, 2, 2)).toBe(0);
  });
});

describe("buildMask", () => {
  const W = 200, H = 100;

  it("masque à la taille de l'image source", () => {
    const m = buildMask(detections(W, H));
    expect(m.width).toBe(W);
    expect(m.height).toBe(H);
    expect(count(m)).toBe(0);
  });

  it("union : boîtes ET segmentation", () => {
    const seg = emptyProb(10, 10);
    seg.data[2 * 10 + 8] = 0.9; // en haut à droite
    const det = detections(W, H, {
      segmentationMask: seg,
      boxes: [{ x: 10, y: 50, width: 20, height: 30, score: 0.6 }],
    });
    const union = buildMask(det, { dilation: 0 });
    expect(at(union, 15, 60)).toBe(1); // boîte
    expect(at(union, 170, 25)).toBe(1); // segmentation
    const segOnly = buildMask(det, { dilation: 0, mode: "segmentation" });
    expect(at(segOnly, 15, 60)).toBe(0);
    expect(at(segOnly, 170, 25)).toBe(1);
    const detOnly = buildMask(det, { dilation: 0, mode: "detection" });
    expect(at(detOnly, 15, 60)).toBe(1);
    expect(at(detOnly, 170, 25)).toBe(0);
  });

  it("respecte les seuils", () => {
    const det = detections(W, H, { boxes: [{ x: 0, y: 0, width: 10, height: 10, score: 0.2 }] });
    expect(count(buildMask(det, { threshold: 0.3, dilation: 0 }))).toBe(0);
    expect(count(buildMask(det, { threshold: 0.1, dilation: 0 }))).toBe(100);
    expect(count(buildMask(det, { threshold: 0.5, boxThreshold: 0.15, dilation: 0 }))).toBe(100);
  });

  it("arrondit les boîtes vers l'extérieur et les borne à l'image", () => {
    const det = detections(W, H, { boxes: [{ x: -5.5, y: 95.2, width: 10.1, height: 20, score: 1 }] });
    const m = buildMask(det, { dilation: 0 });
    expect(at(m, 0, 95)).toBe(1);
    expect(at(m, 4, 99)).toBe(1);
    expect(at(m, 5, 99)).toBe(0);
  });

  it("la dilatation agrandit la zone effacée", () => {
    const det = detections(W, H, { boxes: [{ x: 90, y: 40, width: 20, height: 20, score: 1 }] });
    const a = buildMask(det, { dilation: 0 });
    const b = buildMask(det, { dilation: 0.05 }); // rayon 5 px
    expect(count(b)).toBeGreaterThan(count(a));
    expect(at(b, 85, 50)).toBe(1);
    expect(at(b, 84, 50)).toBe(0);
    expect(maskCoverage(a)).toBeCloseTo(400 / (W * H));
  });
});
