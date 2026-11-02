import { describe, expect, it } from "vitest";
import { listPngChunks, stripPngMetadata } from "../src/core/png";
import { applyMaskToImageData } from "../src/core/apply";
import { createMask } from "../src/core/mask";

function chunk(type: string, data: number[] = []): number[] {
  const len = data.length;
  return [
    (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255,
    ...Array.from(type, (c) => c.charCodeAt(0)),
    ...data,
    0, 0, 0, 0, // CRC (non vérifié ici)
  ];
}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

describe("stripPngMetadata", () => {
  it("ne garde que les chunks nécessaires au décodage", () => {
    const png = new Uint8Array([
      ...SIG,
      ...chunk("IHDR", Array(13).fill(1)),
      ...chunk("eXIf", [77, 77, 0, 42]),
      ...chunk("iCCP", [1, 2, 3]),
      ...chunk("tEXt", Array.from("GPS\0secret", (c) => c.charCodeAt(0))),
      ...chunk("pHYs", Array(9).fill(0)),
      ...chunk("IDAT", [9, 9, 9]),
      ...chunk("tIME", Array(7).fill(0)),
      ...chunk("IDAT", [8]),
      ...chunk("IEND"),
    ]);
    const out = stripPngMetadata(png);
    expect(listPngChunks(out).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IDAT", "IEND"]);
    expect(new TextDecoder().decode(out)).not.toContain("secret");
  });

  it("refuse ce qui n'est pas un PNG", () => {
    expect(() => stripPngMetadata(new Uint8Array([0xff, 0xd8, 0xff]))).toThrow();
  });
});

describe("applyMaskToImageData", () => {
  it("met alpha ET couleur à zéro sous le masque", () => {
    const img = { width: 2, height: 1, data: new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]) } as ImageData;
    const m = createMask(2, 1);
    m.data[1] = 1;
    applyMaskToImageData(img, m);
    expect(Array.from(img.data)).toEqual([10, 20, 30, 255, 0, 0, 0, 0]);
  });

  it("refuse un masque de mauvaise taille", () => {
    const img = { width: 2, height: 2, data: new Uint8ClampedArray(16) } as ImageData;
    expect(() => applyMaskToImageData(img, createMask(1, 1))).toThrow();
  });
});
