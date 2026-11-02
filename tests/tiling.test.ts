import { describe, expect, it } from "vitest";
import { autoGrid, compositeMax, fitWithin, planTiles } from "../src/core/tiling";
import type { ProbMap } from "../src/core/types";

describe("planTiles", () => {
  it("petite image : image entière seulement", () => {
    expect(planTiles(600, 400)).toEqual([{ x: 0, y: 0, width: 600, height: 400 }]);
  });

  it("grille automatique selon le grand côté et la précision", () => {
    expect(autoGrid(600, 400)).toBe(1);
    expect(autoGrid(900, 600)).toBe(2);
    expect(autoGrid(1523, 1011)).toBe(3);
    expect(autoGrid(4032, 3024)).toBe(4);
    expect(autoGrid(600, 400, "high")).toBe(2);
    expect(autoGrid(4032, 3024, "high")).toBe(5);
  });

  it("photo 12 Mpx : image entière + grille 4×3 qui couvre tout avec chevauchement", () => {
    const W = 4032, H = 3024;
    const rects = planTiles(W, H);
    expect(rects[0]).toEqual({ x: 0, y: 0, width: W, height: H });
    const tiles = rects.slice(1);
    expect(tiles.length).toBe(4 * 3);
    // couverture complète
    for (const [px, py] of [[0, 0], [W - 1, H - 1], [W / 2, H / 2], [1500, 1600]]) {
      expect(tiles.some((t) => px >= t.x && px < t.x + t.width && py >= t.y && py < t.y + t.height)).toBe(true);
    }
    // chevauchement horizontal entre tuiles voisines
    const row = tiles.filter((t) => t.y === 0).sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) {
      expect(row[i - 1].x + row[i - 1].width).toBeGreaterThan(row[i].x);
    }
    for (const t of tiles) {
      expect(t.x + t.width).toBeLessThanOrEqual(W);
      expect(t.y + t.height).toBeLessThanOrEqual(H);
    }
  });

  it("portrait : la grille suit le grand côté", () => {
    const tiles = planTiles(3024, 4032, { grid: 3 }).slice(1);
    const xs = new Set(tiles.map((t) => t.x));
    const ys = new Set(tiles.map((t) => t.y));
    expect(xs.size).toBe(2);
    expect(ys.size).toBe(3);
  });

  it("grid = 1 désactive les tuiles", () => {
    expect(planTiles(4000, 3000, { grid: 1 }).length).toBe(1);
  });
});

describe("fitWithin", () => {
  it("réduit en gardant les proportions et n'agrandit jamais", () => {
    expect(fitWithin(4000, 3000, 640)).toEqual({ width: 640, height: 480 });
    expect(fitWithin(300, 200, 640)).toEqual({ width: 300, height: 200 });
  });
});

describe("compositeMax", () => {
  it("place la carte d'une tuile au bon endroit et garde le maximum", () => {
    const target: ProbMap = { width: 100, height: 100, data: new Float32Array(100 * 100) };
    target.data[0] = 0.7;
    const src: ProbMap = { width: 10, height: 10, data: new Float32Array(100).fill(0.5) };
    // tuile = quart inférieur droit d'une image source 1000×1000
    compositeMax(target, src, { x: 500, y: 500, width: 500, height: 500 }, 1000, 1000);
    expect(target.data[0]).toBeCloseTo(0.7);
    expect(target.data[49 * 100 + 49]).toBe(0);
    expect(target.data[50 * 100 + 50]).toBeCloseTo(0.5);
    expect(target.data[99 * 100 + 99]).toBeCloseTo(0.5);
    // un max plus faible n'écrase pas
    const low: ProbMap = { width: 1, height: 1, data: new Float32Array([0.1]) };
    compositeMax(target, low, { x: 0, y: 0, width: 1000, height: 1000 }, 1000, 1000);
    expect(target.data[99 * 100 + 99]).toBeCloseTo(0.5);
  });
});
